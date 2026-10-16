import { cleanChapter, jobKey } from './profiles.js';
import { contentHash } from './core.js';
import { classifyRecoveryError, faultOf, pushFault, redact } from './recovery.js';
// Guards against the same task being driven by two engine instances in one JS
// context (e.g. a bug or a test). Cross-context exclusion is enforced by the
// panel's per-task Web Lock (navigator.locks.request('task:<id>')).
const runningTasks = new Set();
const MAX_CHAPTER_ATTEMPTS = 2;
function chapterRecovery(value) {
  const recovery = classifyRecoveryError(value);
  const globalFailure =
    ['auth', 'network', 'storage'].includes(recovery.reason) ||
    /任务已更新.*冲突|已删除|原标签页已关闭|离开手册|不在.*(?:范围|来源)|其他来源|不同源|重新校准|请先点选|定位规则失效|文档框架|permission|not allowed|access.*denied|无法确认错误标签页/i.test(
      recovery.message,
    );
  return { ...recovery, scope: globalFailure ? 'task' : 'chapter' };
}
export function createTask(profile, product = '未知', version = '未知') {
  return {
    schemaVersion: 2,
    taskId: jobKey(profile, product, version),
    profileId: profile.id,
    profileRevision: profile.revision,
    profile,
    entry: profile.entry,
    sourceKind: 'web',
    product: product || '未知',
    version: version || '未知',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'ready',
    queue: [],
    pages: {},
    discoveryWarnings: [],
    scanDiagnostics: {},
  };
}
export class ImportEngine {
  constructor(task, io) {
    this.task = task;
    this.io = io;
    this.paused = false;
    this.running = false;
  }
  pause() {
    this.paused = true;
  }
  async checkpoint(key = null) {
    this.task.updatedAt = new Date().toISOString();
    // A durable heartbeat lets a reopened console tell an interrupted task from
    // one that is still being collected. It is not background execution.
    this.task.heartbeat = {
      at: this.task.updatedAt,
      status: this.task.status,
      chapter: this.task.queue?.find((c) => c.status === 'processing')?.title || null,
    };
    try {
      await this.io.save(this.task, key);
    } catch (error) {
      throw Object.assign(new Error(error?.message || String(error), { cause: error }), {
        code: 'STORAGE_ERROR',
      });
    }
    // A rendering problem in the control page must never abort a running import:
    // the captured page is already stored by the time the refresh is attempted.
    try {
      this.io.onChange?.(this.task);
    } catch (error) {
      console.warn('ManualDock：控制页刷新失败，采集继续。', error);
    }
  }
  merge(items = []) {
    const known = new Set(this.task.queue.map((c) => c.key));
    for (const raw of items) {
      const chapter = cleanChapter(raw, this.task.profile);
      if (!chapter || known.has(chapter.key)) continue;
      if (this.task.queue.length >= 5000) {
        this.task.discoveryWarnings.push('目录超过5000章上限，尚未加入剩余章节');
        break;
      }
      known.add(chapter.key);
      this.task.queue.push({ ...chapter, status: 'pending' });
    }
  }
  async scan() {
    const result = await this.io.discover(this.task.profile);
    if (result.status === 'auth') {
      this.task.status = 'waiting_login';
      this.task.recovery = {
        ...classifyRecoveryError(result),
        scope: 'task',
        message: '登录已失效，等待用户登录后恢复',
      };
      await this.checkpoint();
      return false;
    }
    if (result.status === 'error' || result.diagnostics?.reason === 'invalid-directory')
      throw Object.assign(
        new Error(result.error || result.warnings?.[0] || '目录规则已失效，请重新校准'),
        { code: result.code },
      );
    this.merge(result.items || []);
    this.task.scanDiagnostics = result.diagnostics || {};
    this.task.discoveryWarnings = [
      ...new Set([...this.task.discoveryWarnings, ...(result.warnings || [])]),
    ];
    if (!this.task.queue.length)
      throw new Error('未识别到章节；请点选目录和正文，并验证两个示例章节');
    await this.checkpoint();
    return true;
  }
  async run({ chapterKey = null } = {}) {
    if (this.running) return;
    if (runningTasks.has(this.task.taskId)) return; // same-context double-run guard
    this.running = true;
    this.paused = false;
    runningTasks.add(this.task.taskId);
    try {
      if (chapterKey !== null) {
        const requested = this.task.queue.find((c) => c.key === chapterKey);
        if (!requested) throw new Error('指定章节未在当前任务目录中，请先识别当前章节');
        requested.status = 'pending';
      } else
        for (const c of this.task.queue)
          if (['processing', 'waiting_login'].includes(c.status)) c.status = 'pending';
      delete this.task.recovery;
      this.task.status = 'running';
      await this.checkpoint();
      // Saved queues are already bounded and validated; capture still checks the
      // current source and chapter proof. Only an explicit scan expands the TOC.
      if (chapterKey === null && !this.task.queue.length && !(await this.scan())) return;
      const attempts = new Map();
      while (!this.paused) {
        const chapter = this.task.queue.find(
          (c) => c.status === 'pending' && (chapterKey === null || c.key === chapterKey),
        );
        if (!chapter) break;
        chapter.status = 'processing';
        delete chapter.error;
        delete chapter.recovery;
        attempts.set(chapter.key, (attempts.get(chapter.key) || 0) + 1);
        await this.checkpoint();
        // Keep the structured fault and the console record so the failing frame
        // can be identified later; do not collapse to a bare message.
        let page;
        try {
          page = await this.io.capture(chapter, this.task.profile);
        } catch (error) {
          console.error('ManualDock：章节采集失败', chapter.key, error);
          const fault = faultOf(error, error?.stage || 'capture-chapter', chapter);
          page = {
            status: 'error',
            error: error.message,
            code: error.code,
            diagnostics: { ...(page?.diagnostics || {}), fault },
          };
        }
        if (page.status === 'auth') {
          chapter.status = 'waiting_login';
          chapter.recovery = chapterRecovery(page);
          this.task.status = 'waiting_login';
          this.task.recovery = { ...chapter.recovery, message: '登录已失效，等待用户登录后恢复' };
          await this.checkpoint();
          return;
        }
        const hasBody =
          Boolean(page.text?.trim()) ||
          (Number.isInteger(page.diagnostics?.images?.embedded) &&
            page.diagnostics.images.embedded > 0 &&
            /<img\b[^>]*src=["']data:image\//i.test(page.html || ''));
        if (page.status !== 'ok' || !hasBody || page.navigationProof?.verified !== true) {
          chapter.status = 'failed';
          chapter.error = page.error || page.diagnostics?.reason || '未确认所选章节的正文加载完成';
          chapter.recovery = chapterRecovery({ ...page, error: chapter.error });
          this.task.recovery = { ...chapter.recovery, message: redact(chapter.error) };
          pushFault(
            this.task,
            faultOf(
              { message: chapter.error, fault: page.diagnostics?.fault },
              'capture-chapter',
              chapter,
            ),
          );
          // Isolate a bad chapter. Only transient local failures get one immediate
          // retry; network/scope failures stop before another chapter is opened.
          if (chapter.recovery.scope === 'task') this.paused = true;
          else if (chapter.recovery.retryable && attempts.get(chapter.key) < MAX_CHAPTER_ATTEMPTS)
            chapter.status = 'pending';
          await this.checkpoint();
          continue;
        }
        // Compute the hash and the page record first; only then commit it to
        // memory and persist together. A storage failure must NOT leave the
        // chapter marked captured and must stop the run rather than keep
        // collecting on storage we could not confirm.
        let hash, duplicate, record;
        try {
          hash = await contentHash(page.text?.trim() ? page.text : page.html);
          duplicate = Object.entries(this.task.pages).find(
            ([key, p]) => key !== chapter.key && p.hash === hash,
          );
          chapter.status = duplicate ? 'review' : 'captured';
          if (duplicate) chapter.error = '正文与其他章节相同，已保留，待核对';
          record = { ...page, key: chapter.key, hash, capturedAt: new Date().toISOString() };
        } catch (error) {
          console.error('ManualDock：章节处理失败', chapter.key, error);
          chapter.status = 'failed';
          chapter.error = error?.message || '章节处理失败';
          chapter.recovery = chapterRecovery(error);
          this.task.recovery = { ...chapter.recovery, message: redact(chapter.error) };
          pushFault(this.task, faultOf(error, 'process-chapter', chapter));
          if (chapter.recovery.scope === 'task') this.paused = true;
          await this.checkpoint();
          continue;
        }
        const previousPage = this.task.pages[chapter.key];
        try {
          this.task.pages[chapter.key] = record;
          await this.checkpoint(chapter.key);
        } catch (error) {
          // Storage failed: revert the in-memory record so a later successful
          // checkpoint cannot persist a body for a chapter that was never saved,
          // then stop the run and wait for recovery (do NOT mark it captured).
          if (previousPage === undefined) delete this.task.pages[chapter.key];
          else this.task.pages[chapter.key] = previousPage;
          chapter.status = 'failed';
          const cause = redact(error?.message || '');
          chapter.error = cause
            ? `${cause}（章节存档失败，已停止采集，等待恢复）`
            : '章节存档失败，已停止采集，等待恢复';
          this.task.recovery = {
            retryable: false,
            reason: 'storage',
            scope: 'task',
            message: chapter.error,
          };
          chapter.recovery = { ...this.task.recovery };
          pushFault(this.task, faultOf(error, 'save-chapter', chapter));
          this.paused = true;
          console.error('ManualDock：章节存档失败，停止采集', chapter.key, error);
          await this.checkpoint().catch((e) => console.warn('ManualDock：记录存档失败未完成。', e));
          break;
        }
      }
      if (this.task.recovery?.scope === 'chapter') {
        const failed = this.task.queue.filter((c) => c.status === 'failed');
        const remaining = failed.find((c) => c.recovery?.retryable) || failed[0];
        if (remaining)
          this.task.recovery = { ...remaining.recovery, message: redact(remaining.error) };
        else delete this.task.recovery;
      }
      // The whole task is only finished when nothing is left pending, processing,
      // waiting for login, or failed. Otherwise report it as still incomplete.
      const blocked = this.task.queue.some((c) =>
        ['pending', 'processing', 'waiting_login'].includes(c.status),
      );
      const hasFailed = this.task.queue.some((c) => c.status === 'failed');
      this.task.status = this.paused || blocked || hasFailed ? 'paused' : 'finished';
      await this.checkpoint();
    } catch (error) {
      console.error('ManualDock：采集中断', error);
      this.task.status = 'paused';
      this.task.recovery = {
        ...classifyRecoveryError(error),
        scope: 'task',
        message: redact(error.message),
        stack: redact(String(error?.stack || '')).slice(0, 4000),
      };
      await this.checkpoint();
      throw error;
    } finally {
      this.running = false;
      runningTasks.delete(this.task.taskId);
    }
  }
}
