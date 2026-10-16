import { createBrowserIO } from './browser-io.js';
import { createTask, ImportEngine } from './engine.js';
import {
  cleanChapter,
  jobKey,
  normalizeDocumentURL,
  ruleSignature,
  selectSavedProfile,
  validateProfile,
} from './profiles.js';
import * as taskStore from './task-store.js';
import { AutoRetryClock } from './auto-retry.js';
import {
  scheduleRecovery,
  savedChapterCount,
  classifyRecoveryError,
  recoveryError,
  redact,
  resetRetryableChapters,
  taskHasRetryableWork,
  resetInterruptedChapters,
  faultOf,
  pushFault,
} from './recovery.js';

const hasRegions = (profile) =>
  ['tocSelector', 'contentSelector'].every((key) => profile?.[key]?.trim());
const hasReusableRegions = (profile, task) => {
  if (hasRegions(profile)) return true;
  if (!profile?.tocSelector?.trim() || task?.validation?.signature !== ruleSignature(profile))
    return false;
  const samples = (profile.samples || []).map((sample) => cleanChapter(sample, profile));
  return samples.length === 2 && samples.every(Boolean) && samples[0].key !== samples[1].key;
};
const canExpandDirectory = (task) => {
  const scan = task?.scanDiagnostics || {};
  return (
    !task?.directoryExpansionAttempted &&
    Boolean(scan.pendingBranches > 0 || scan.truncated || scan.expansionLimited)
  );
};
const emptyDirectoryMessage = (task) =>
  canExpandDirectory(task)
    ? '尚未找到章节，目录仍有未展开部分；可点击“采集整本”展开，或查看来源校准目录'
    : '未找到可采集章节，请选择正确目录并重新扫描；也可先记录当前章';

/** A source owns its IO, engine, retry timer and state, independently of the UI. */
export class SourceSession {
  constructor({
    tabId,
    purpose = 'document',
    onChange = () => {},
    onError = () => {},
    io = createBrowserIO(tabId),
    locks = navigator.locks,
    store = taskStore,
    clockOptions = {},
  }) {
    if (!['document', 'rotation'].includes(purpose)) throw new Error('不支持的来源用途');
    Object.defineProperty(this, 'purpose', { value: purpose, enumerable: true });
    Object.assign(this, { tabId, onChange, onError, io, locks, store });
    this.task = null;
    this.profile = null;
    this.engine = null;
    this.draft = null;
    this.operation = '';
    this.busy = false;
    this.initialized = false;
    this.connected = false;
    this.disposed = false;
    this.closed = false;
    this.deleted = false;
    this.error = '';
    this.address = '';
    this.title = '';
    this.generation = 0;
    this.retryClock = new AutoRetryClock({
      ...clockOptions,
      getTask: () =>
        this.purpose === 'document' &&
        this.initialized &&
        !this.disposed &&
        !this.closed &&
        this.task?.autoRecovery?.sourceTabId === this.tabId
          ? this.task
          : null,
      retry: (taskId) => this.start({ automatic: true, expectedTaskId: taskId }),
      onError: (error) => this.fail(error),
    });
  }
  assertDocument() {
    if (this.purpose !== 'document')
      throw new Error('此来源用于菜单轮换，请使用独立标签页进行文档采集');
  }
  emit() {
    if (this.disposed) return;
    try {
      this.onChange(this.getState(), this);
    } catch (error) {
      console.warn('ManualDock：来源状态刷新失败', error);
    }
  }
  fail(error) {
    this.error = redact(error?.message || String(error));
    try {
      this.onError(error, this);
    } catch {
      /* UI callbacks cannot affect saved data. */
    }
    this.emit();
  }
  canResumeFailedScan() {
    const { task, profile, draft } = this;
    if (this.initialized || !task?.queue.length || !profile || !draft?.task) return false;
    const signature = ruleSignature(profile);
    const samples = (profile.samples || []).map((sample) => cleanChapter(sample, profile));
    const sameProfile = (candidate) =>
      candidate?.id === profile.id &&
      candidate?.revision === profile.revision &&
      ruleSignature(candidate) === signature &&
      JSON.stringify(candidate.samples || []) === JSON.stringify(profile.samples || []);
    return Boolean(
      samples.length === 2 &&
      samples.every(Boolean) &&
      samples[0].key !== samples[1].key &&
      task.validation?.signature === signature &&
      task.profileId === profile.id &&
      task.profileRevision === profile.revision &&
      task.taskId === jobKey(profile, task.product, task.version) &&
      draft.task.taskId === task.taskId &&
      draft.task.product === task.product &&
      draft.task.version === task.version &&
      sameProfile(task.profile) &&
      sameProfile(draft.profile),
    );
  }
  getState() {
    const queue = this.task?.queue || [];
    const emptyDirectory = this.initialized && this.task && !queue.length;
    const canAct =
      this.purpose === 'document' &&
      (this.initialized ? Boolean(this.profile && this.task) : this.connected && !this.error) &&
      !this.busy &&
      !this.closed &&
      !this.deleted &&
      !this.disposed;
    const canResume =
      this.purpose === 'document' &&
      !this.busy &&
      !this.closed &&
      !this.deleted &&
      !this.disposed &&
      this.canResumeFailedScan();
    const canStart =
      canResume ||
      (canAct && (!this.initialized || queue.length > 0 || canExpandDirectory(this.task)));
    // Bulk collection only consumes prepared work. It must not implicitly
    // recognize every connected page or repeatedly start completed archives.
    const canValidate =
      queue.length >= 2 ||
      Boolean(this.profile && this.task?.validation?.signature === ruleSignature(this.profile));
    const hasPending =
      queue.some((chapter) =>
        ['pending', 'processing', 'waiting_login'].includes(chapter.status),
      ) || canExpandDirectory(this.task);
    return {
      tabId: this.tabId,
      purpose: this.purpose,
      taskId: this.task?.taskId || '',
      product: this.task?.product || this.title,
      address: this.address,
      progress: {
        captured: queue.filter((chapter) => chapter.status === 'captured').length,
        total: queue.length,
        remaining: queue.filter((chapter) =>
          ['pending', 'processing', 'waiting_login'].includes(chapter.status),
        ).length,
        issues: queue.filter((chapter) => ['failed', 'review'].includes(chapter.status)).length,
      },
      status:
        this.busy && this.operation === 'scanning'
          ? 'scanning'
          : this.deleted
            ? 'deleted'
            : this.closed
              ? 'closed'
              : !this.initialized && this.busy
                ? 'initializing'
                : (!this.initialized && this.error) || emptyDirectory
                  ? 'needs_calibration'
                  : this.task?.status || (this.connected ? 'connected' : 'ready'),
      busy: this.busy,
      initialized: this.initialized,
      error:
        this.error ||
        (emptyDirectory ? emptyDirectoryMessage(this.task) : '') ||
        (this.task?.status !== 'running' ? this.task?.recovery?.message || '' : ''),
      canStart,
      canResume,
      canStartBatch: Boolean(canStart && this.initialized && canValidate && hasPending),
      canCaptureCurrent: canAct,
      canPause:
        this.purpose === 'document' && (this.busy || Boolean(this.task?.autoRecovery?.enabled)),
    };
  }
  async lock(name, action) {
    return this.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock)
        throw new Error(
          name.startsWith('task:')
            ? '这份手册正在另一个来源采集，请先暂停'
            : '另一个操作正在使用此来源标签页，请先暂停',
        );
      return action();
    });
  }
  /** Explicit new collection may reuse calibration, never a deleted task identity. */
  async createFreshTask(profile, product = profile.name, version = '未知') {
    this.assertDocument();
    let selected = validateProfile(profile);
    let task = createTask(selected, product, version);
    if (await this.store.getSetting('deleted-task:' + task.taskId)) {
      selected = validateProfile({ ...selected, id: crypto.randomUUID(), revision: 1 });
      task = createTask(selected, product, version);
      task.discoveryWarnings.push('原任务已被删除，本次采集使用新任务；原删除记录仍保留');
    }
    return { task, profile: selected };
  }
  async reload() {
    this.assertDocument();
    const saved = await this.store.loadTask(this.task.taskId);
    if (!saved && this.task.storageRevision) throw new Error('任务已删除，已停止此来源');
    if (saved) {
      this.task = saved;
      this.profile = saved.profile;
    }
  }
  engineForTask() {
    this.assertDocument();
    this.engine = new ImportEngine(this.task, {
      discover: (profile) => this.io.discover(profile, { expand: false }),
      capture: (chapter, profile) => this.io.capture(chapter, profile),
      save: (task, key) => this.store.saveTask(task, key),
      onChange: () => this.emit(),
    });
    return this.engine;
  }
  /** A selected tree node proves chapter identity when clicks change the URL. */
  async matchesBoundChapter(address, profile, task) {
    if (
      profile?.navigation !== 'click' ||
      !normalizeDocumentURL(address, profile) ||
      new URL(address).pathname !== new URL(profile.entry).pathname ||
      typeof this.io.current !== 'function' ||
      selectSavedProfile(profile.entry, [profile], [task]).task?.taskId !== task.taskId
    )
      return false;
    const current = await (this.io.boundCurrent || this.io.current).call(this.io, profile);
    const chapter = current?.status === 'ok' && cleanChapter(current.chapter, profile);
    return Boolean(
      chapter?.locator &&
      task.queue.filter((item) => item.key === chapter.key && item.title === chapter.title)
        .length === 1,
    );
  }
  async savedRecovery(current, expectedTaskId = null) {
    this.assertDocument();
    const binding = expectedTaskId || (await this.store.getSetting('recovery-tab:' + this.tabId));
    let saved = binding ? await this.store.loadTask(binding) : null;
    if (!saved && !expectedTaskId) {
      const candidates = (await this.store.listTasks()).filter(
        (task) =>
          task.sourceKind === 'web' &&
          task.autoRecovery?.enabled &&
          task.autoRecovery.sourceTabId === this.tabId,
      );
      if (candidates.length === 1) saved = await this.store.loadTask(candidates[0].taskId);
    }
    if (
      !saved?.autoRecovery?.enabled ||
      saved.autoRecovery.sourceTabId !== this.tabId ||
      saved.sourceKind !== 'web'
    )
      return null;
    const profile = validateProfile(saved.profile);
    if (
      saved.profileId !== profile.id ||
      saved.profileRevision !== profile.revision ||
      saved.taskId !== jobKey(profile, saved.product, saved.version)
    )
      throw new Error('已保存恢复任务与规则不匹配，请从资料库检查');
    const browserError = /^chrome-error:\/\//i.test(current.url || '');
    const address = browserError ? current.pendingUrl : current.url;
    let url;
    try {
      url = new URL(address);
    } catch {
      throw new Error('无法确认错误标签页仍属于手册范围，请重新打开原手册');
    }
    if (url.origin !== profile.origin || url.username || url.password)
      throw new Error('来源已离开原手册网站，已停止恢复');
    const login = /\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(url.pathname);
    const proven =
      selectSavedProfile(address, [profile], [saved]).status === 'selected' ||
      (!browserError && !login && (await this.matchesBoundChapter(address, profile, saved)));
    if (browserError ? !normalizeDocumentURL(address, profile) : !proven && !login)
      throw new Error('无法确认恢复页面仍属于原手册范围，请检查来源');
    return { task: saved, profile, address };
  }
  /** Register a control target without reading content or starting recovery. */
  async connect() {
    if (this.disposed || this.closed) return;
    try {
      const tab = await this.io.tab();
      const url = new URL(/^chrome-error:/i.test(tab.url || '') ? tab.pendingUrl : tab.url);
      if (
        !Number.isInteger(this.tabId) ||
        this.tabId <= 0 ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('只支持 HTTP/HTTPS 页面，请检查页面地址');
      if (this.disposed || this.closed) return;
      this.address = url.origin + url.pathname;
      this.title = String(tab.title || url.hostname);
      this.connected = true;
      this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  async initialize({ taskId = null } = {}) {
    this.assertDocument();
    if (this.busy || this.initialized || this.disposed || this.closed) return;
    this.busy = true;
    this.error = '';
    const generation = ++this.generation;
    let candidateDraft = null;
    this.draft = null;
    this.emit();
    try {
      await this.lock('source-tab:' + this.tabId, async () => {
        const tab = await this.io.tab();
        const recovery = await this.savedRecovery(tab, taskId);
        const url = new URL(recovery?.address || tab.url);
        if (
          !Number.isInteger(this.tabId) ||
          this.tabId <= 0 ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error('请从 HTTP/HTTPS 手册页面加入来源');
        this.connected = true;
        this.address = url.origin + url.pathname;
        this.title = String(tab.title || url.hostname);
        const [profiles, tasks] = await Promise.all([
          this.store.loadProfiles(),
          this.store.listTasks(),
        ]);
        let selected;
        if (recovery) selected = { status: 'selected', ...recovery };
        else if (taskId) {
          const bound = await this.store.loadTask(taskId);
          if (!bound) throw new Error('原任务已删除；可重新扫描当前页面建立新任务');
          const boundProfile = validateProfile(bound.profile);
          selected = selectSavedProfile(tab.url, [boundProfile], [bound]);
          if (!selected.task && (await this.matchesBoundChapter(tab.url, boundProfile, bound)))
            selected = { status: 'selected', profile: boundProfile, task: bound };
          if (!selected.task) throw new Error('当前来源与原任务不匹配，请回到手册页面后重新扫描');
        } else selected = selectSavedProfile(tab.url, profiles, tasks);
        // Historical ambiguity is not a reason to block fresh recognition.
        // Only a unique reusable task is adopted; all other archives remain intact.
        let warnings = [];
        if (selected.status === 'selected') {
          this.profile = validateProfile(selected.profile);
          if (selected.task) this.task = selected.task;
          else
            ({ task: this.task, profile: this.profile } = await this.createFreshTask(this.profile));
        }
        const repair =
          selected.status === 'selected' &&
          !recovery &&
          !hasReusableRegions(this.profile, this.task);
        if (selected.status !== 'selected' || repair) {
          // A failed initial detection may have saved an incomplete draft. It is
          // not a reusable calibration, even when its entry URL still matches.
          if (repair && selected.task)
            this.task = (await this.store.loadTask(selected.task.taskId)) || this.task;
          const previousTask = repair ? this.task : null;
          const detected = await this.io.detect();
          const candidate = validateProfile({
            ...detected.profile,
            ...(repair || selected.status === 'ambiguous'
              ? { id: crypto.randomUUID(), revision: 1, samples: [] }
              : {}),
          });
          warnings = detected.warnings || [];
          if (generation !== this.generation || this.disposed || this.closed) return;
          const created = await this.createFreshTask(
            candidate,
            previousTask?.product || candidate.name,
            previousTask?.version,
          );
          if (generation !== this.generation || this.disposed || this.closed) return;
          // Keep a rejected detection available for manual calibration without
          // replacing the selected archive or persisting an unconfirmed rule.
          candidateDraft = { ...created, warnings };
          candidateDraft.task.discoveryWarnings = warnings;
          if (repair) {
            if (!hasRegions(candidate))
              throw new Error('仍未识别完整的目录和正文，请查看来源并点选缺失区域；原存档已保留');
            warnings.push('已重新识别缺失的目录或正文并新建任务；原规则和已保存章节仍在资料库');
          }
          if (!hasRegions(candidate))
            throw new Error('未识别完整的目录和正文，请查看来源并点选缺失区域');
          this.profile = candidateDraft.profile;
          this.task = candidateDraft.task;
        }
        if (generation !== this.generation || this.disposed) return;
        await this.lock('task:' + this.task.taskId, async () => {
          await this.reload();
          if (generation !== this.generation || this.disposed) return;
          if (this.task.status === 'running') this.task.status = 'paused';
          for (const chapter of this.task.queue)
            if (chapter.status === 'processing') chapter.status = 'pending';
          if (!this.task.queue.length && !recovery) {
            const discovered = await this.io.discover(this.profile, { expand: false });
            if (discovered.status === 'auth')
              throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
            if (discovered.status === 'error')
              throw new Error(discovered.error || '未能读取目录，请查看来源并校准');
            this.engineForTask().merge(discovered.items || []);
            this.task.scanDiagnostics = discovered.diagnostics || {};
            warnings.push(...(discovered.warnings || []));
          }
          this.task.discoveryWarnings = [
            ...new Set([...(this.task.discoveryWarnings || []), ...warnings]),
          ];
          if (!this.task.queue.length) {
            this.task.status = 'needs_calibration';
            this.error = emptyDirectoryMessage(this.task);
            this.task.autoRecovery = {
              ...this.task.autoRecovery,
              enabled: false,
              nextAttemptAt: null,
            };
          } else if (this.task.status === 'needs_calibration') this.task.status = 'ready';
          await this.store.saveProfile(this.profile);
          if (
            this.task.autoRecovery?.enabled &&
            this.task.autoRecovery.sourceTabId === this.tabId &&
            !Number.isFinite(this.task.autoRecovery.nextAttemptAt)
          )
            this.task.autoRecovery.nextAttemptAt = Date.now() + 5000;
          await this.store.saveTask(this.task);
          this.initialized = true;
          this.draft = null;
        });
      });
    } catch (error) {
      this.draft = candidateDraft;
      this.initialized = false;
      this.fail(error);
    } finally {
      this.busy = false;
      this.emit();
      this.retryClock.refresh();
    }
  }
  /** Scan this source independently of whichever source the workspace displays. */
  async scanDirectory({
    detect = false,
    profile = null,
    product = '',
    version = '',
    expand = false,
  } = {}) {
    this.assertDocument();
    if (this.busy) throw new Error('此来源正在操作，请等待完成或暂停后再扫描');
    if (this.disposed || this.closed) throw new Error('来源已关闭，无法扫描目录');
    const generation = ++this.generation;
    const shouldContinue = () => generation === this.generation && !this.disposed && !this.closed;
    const check = () => {
      if (!shouldContinue()) throw recoveryError('扫描已暂停，未保存新的目录结果', 'CANCELLED');
    };
    let candidate = null,
      draftTask = null,
      warnings = [];
    this.busy = true;
    this.operation = 'scanning';
    this.error = '';
    this.retryClock.dispose();
    this.emit();
    try {
      return await this.lock('source-tab:' + this.tabId, async () => {
        check();
        const tab = await this.io.tab();
        check();
        let selected = null;
        if (detect) {
          const result = await this.io.detect();
          check();
          candidate = validateProfile(result.profile);
          warnings = result.warnings || [];
          const [profiles, tasks] = await Promise.all([
            this.store.loadProfiles(),
            this.store.listTasks(),
          ]);
          check();
          const matches = [
            ...new Map(
              [...profiles, ...(this.profile ? [this.profile] : [])]
                .filter(
                  (saved) =>
                    ruleSignature(saved) === ruleSignature({ ...candidate, entry: saved.entry }) &&
                    selectSavedProfile(tab.url, [saved], tasks).status !== 'none',
                )
                .map((saved) => [saved.id + ':' + saved.revision, saved]),
            ).values(),
          ];
          selected = selectSavedProfile(tab.url, matches, tasks);
          // Prefer this source's proven task over similarly named history. Tree
          // items can all use the entry URL while clicks change query parameters.
          if (
            this.profile &&
            this.task &&
            ruleSignature(this.profile) ===
              ruleSignature({ ...candidate, entry: this.profile.entry }) &&
            (selectSavedProfile(tab.url, [this.profile], [this.task]).task ||
              (await this.matchesBoundChapter(tab.url, this.profile, this.task)))
          )
            selected = { status: 'selected', profile: this.profile, task: this.task };
          check();
          if (selected.status === 'ambiguous') selected = { status: 'none' };
          candidate = selected.profile || {
            ...candidate,
            id: crypto.randomUUID(),
            revision: 1,
            samples: [],
          };
        } else candidate = validateProfile(profile || this.profile);
        check();
        if (!normalizeDocumentURL(tab.url, candidate))
          throw new Error('来源页不在所选手册范围内，请重新识别');
        const prior = selected?.task || (this.task?.profileId === candidate.id ? this.task : null);
        const created = await this.createFreshTask(
          candidate,
          product.trim() || prior?.product || candidate.name,
          version.trim() || prior?.version || '未知',
        );
        candidate = created.profile;
        draftTask = created.task;
        check();
        return this.lock('task:' + draftTask.taskId, async () => {
          const saved = await this.store.loadTask(draftTask.taskId);
          check();
          if (saved) {
            if (ruleSignature(saved.profile) !== ruleSignature(candidate))
              throw new Error('已保存任务的校准规则不同，请重新识别后再扫描');
            draftTask = saved; // loadTask includes bodies; listTasks is metadata only.
            // The caller may have just chosen new validation chapters. Keep
            // those explicit choices while reusing the persisted chapter bodies.
            if (JSON.stringify(candidate.samples) !== JSON.stringify(saved.profile.samples || []))
              delete draftTask.validation;
          }
          if (!candidate.tocSelector.trim()) throw new Error('未识别目录，请点选目录后重新扫描');
          const result = await this.io.discover(candidate, { expand: Boolean(expand) });
          check();
          if (result.status === 'auth')
            throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
          if (result.status === 'error' || result.diagnostics?.reason === 'invalid-directory')
            throw new Error(result.error || result.warnings?.[0] || '目录规则已失效，请重新校准');
          new ImportEngine(draftTask, {}).merge(result.items || []);
          draftTask.scanDiagnostics = result.diagnostics || {};
          if (expand) draftTask.directoryExpansionAttempted = true;
          warnings = [
            ...new Set([
              ...(draftTask.discoveryWarnings || []),
              ...warnings,
              ...(result.warnings || []),
            ]),
          ];
          draftTask.discoveryWarnings = warnings;
          draftTask.profile = candidate;
          draftTask.autoRecovery = {
            ...draftTask.autoRecovery,
            enabled: false,
            nextAttemptAt: null,
          };
          draftTask.status =
            draftTask.queue.length && hasReusableRegions(candidate, draftTask)
              ? 'ready'
              : 'needs_calibration';
          draftTask.updatedAt = new Date().toISOString();
          check();
          await this.store.saveProfile(candidate);
          await this.store.saveTask(draftTask, null, { shouldContinue });
          check();
          this.task = draftTask;
          this.profile = candidate;
          this.initialized = hasReusableRegions(candidate, draftTask);
          this.deleted = false;
          this.draft = null;
          this.error = !this.initialized
            ? '目录或正文尚未完成校准；请核对区域并验证两个章节'
            : !draftTask.queue.length
              ? emptyDirectoryMessage(draftTask)
              : '';
          this.connected = true;
          const url = new URL(tab.url);
          this.address = url.origin + url.pathname;
          this.title = String(tab.title || candidate.name);
          return { task: draftTask, profile: candidate, warnings };
        });
      });
    } catch (error) {
      this.draft = candidate ? { task: draftTask, profile: candidate, warnings } : null;
      this.initialized = false;
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
      this.operation = '';
      this.emit();
    }
  }
  async validate(shouldContinue) {
    this.assertDocument();
    const signature = ruleSignature(this.profile);
    if (this.task.validation?.signature === signature) return;
    const samples =
      this.profile.samples?.length === 2
        ? this.profile.samples
        : this.task.queue.slice(0, 2).map((chapter) => cleanChapter(chapter, this.profile));
    if (samples.length !== 2 || !samples.every(Boolean) || samples[0].key === samples[1].key)
      throw new Error('整本采集需要两个不同章节验证；可先记录当前章，或查看来源校准目录');
    this.profile = { ...this.profile, samples };
    const result = await this.io.verifySamples(this.profile, { shouldContinue });
    if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
    if (result?.verified !== true) throw new Error('两个示例章节尚未验证成功，请查看来源');
    this.task.profile = this.profile;
    this.task.validation = { signature, verifiedAt: new Date().toISOString() };
    await this.store.saveProfile(this.profile);
    await this.store.saveTask(this.task);
  }
  async start(options = {}) {
    return this.run(options);
  }
  async captureCurrent() {
    return this.run({ currentOnly: true });
  }
  async run({ automatic = false, expectedTaskId = null, currentOnly = false, retry = false } = {}) {
    this.assertDocument();
    if (this.busy || this.closed || this.disposed || this.deleted) return;
    const resumeFailedScan = !automatic && !currentOnly && this.canResumeFailedScan();
    // Failed calibration stays separate from the validated archive. Only an
    // unchanged failed rescan may recheck it; never initialize/adopt that draft.
    if (this.draft && !this.initialized && !resumeFailedScan) return;
    if (!this.initialized && !automatic && !resumeFailedScan) {
      const pending = this.initialize();
      const generation = this.generation;
      await pending;
      if (generation !== this.generation) return;
    }
    if (
      (!this.initialized && !resumeFailedScan) ||
      !(currentOnly ? this.getState().canCaptureCurrent : this.getState().canStart) ||
      (automatic && (expectedTaskId !== this.task?.taskId || !this.task?.autoRecovery?.enabled))
    )
      return;
    const generation = ++this.generation;
    const shouldContinue = () => generation === this.generation && !this.disposed && !this.closed;
    const expectedAttemptAt = automatic ? this.task.autoRecovery.nextAttemptAt : null;
    this.busy = true;
    this.error = '';
    if (!automatic) this.retryClock.dispose();
    this.emit();
    try {
      await this.lock('source-tab:' + this.tabId, () =>
        this.lock('task:' + this.task.taskId, async () => {
          await this.reload();
          if (!shouldContinue()) return;
          if (resumeFailedScan && !this.canResumeFailedScan())
            throw new Error('原任务或校准规则已变化，请重新扫描并验证');
          if (
            automatic &&
            (!this.task.autoRecovery?.enabled ||
              this.task.autoRecovery.sourceTabId !== this.tabId ||
              this.task.taskId !== expectedTaskId ||
              this.task.autoRecovery.nextAttemptAt !== expectedAttemptAt)
          )
            return;
          const savedBefore = savedChapterCount(this.task);
          const reconnect =
            resumeFailedScan ||
            automatic ||
            taskHasRetryableWork(this.task) ||
            (!currentOnly && this.task.recovery?.scope === 'task');
          this.task.autoRecovery = {
            ...this.task.autoRecovery,
            enabled: !currentOnly,
            nextAttemptAt: null,
            attempts: (this.task.autoRecovery?.attempts || 0) + (automatic ? 1 : 0),
            sourceTabId: this.tabId,
          };
          try {
            await this.store.saveTask(this.task);
            if (!currentOnly)
              await this.store.setSetting('recovery-tab:' + this.tabId, this.task.taskId);
            if (!shouldContinue()) return;
            let rotationCheckDeferred = false;
            try {
              if (await this.io.isRotating?.())
                throw new Error('此来源正在导航轮换，请先停止轮换再采集');
            } catch (error) {
              // Chrome error pages cannot run an injected status check. Recover
              // the already-scoped source, then check again before any samples.
              if (!reconnect || classifyRecoveryError(error).reason !== 'network') throw error;
              rotationCheckDeferred = true;
            }
            if (!shouldContinue()) return;
            if (reconnect) {
              const result = await this.io.recover(this.profile);
              if (result?.status === 'auth')
                throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
            }
            if (rotationCheckDeferred && (await this.io.isRotating?.()))
              throw new Error('此来源正在导航轮换，请先停止轮换再采集');
            if (resumeFailedScan && !this.io.prepare)
              throw recoveryError('页面定位尚未重新检查，请重新校准', 'CALIBRATION_REQUIRED');
            if (!currentOnly && this.io.prepare) {
              const prepared = await this.io.prepare(this.profile, this.task.queue, {
                shouldContinue,
              });
              if (prepared?.status === 'auth')
                throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
              if (!shouldContinue()) return;
              if (prepared?.status !== 'ok') throw new Error('页面定位尚未确认，请重新校准');
              if (prepared.changed) {
                if (!prepared.verified) throw new Error('更新的页面定位尚未验证，请重新校准');
                const candidate = validateProfile(prepared.profile);
                const staged = {
                  ...this.task,
                  profile: candidate,
                  validation: {
                    signature: ruleSignature(candidate),
                    verifiedAt: new Date().toISOString(),
                  },
                };
                await this.store.saveTask(staged, null, { shouldContinue });
                this.task = staged;
                this.profile = candidate;
                if (!shouldContinue()) return;
                await this.store.saveProfile(candidate);
              }
            }
            if (resumeFailedScan && shouldContinue()) {
              this.initialized = true;
              this.draft = null;
            }
            if (reconnect && !automatic && !currentOnly && shouldContinue())
              resetInterruptedChapters(this.task);
            if (!shouldContinue()) return;
            if (!currentOnly) resetRetryableChapters(this.task);
            if (!currentOnly && retry)
              for (const chapter of this.task.queue)
                if (chapter.status === 'failed') {
                  chapter.status = 'pending';
                  delete chapter.error;
                  delete chapter.recovery;
                }
            const scan = this.task.scanDiagnostics || {};
            if (
              !currentOnly &&
              !this.task.directoryExpansionAttempted &&
              (!this.task.queue.length ||
                scan.pendingBranches > 0 ||
                scan.truncated ||
                scan.expansionLimited)
            ) {
              const discovered = await this.io.discover(this.profile, { expand: true });
              if (discovered.status === 'auth')
                throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
              if (discovered.status === 'error')
                throw new Error(discovered.error || '目录展开失败，请查看来源');
              if (!shouldContinue()) return;
              this.engineForTask().merge(discovered.items || []);
              this.task.scanDiagnostics = discovered.diagnostics || {};
              this.task.discoveryWarnings = [
                ...new Set([
                  ...(this.task.discoveryWarnings || []),
                  ...(discovered.warnings || []),
                ]),
              ];
              this.task.directoryExpansionAttempted = true;
              await this.store.saveTask(this.task);
            }
            if (!currentOnly && !this.task.queue.length)
              throw recoveryError(emptyDirectoryMessage(this.task), 'CALIBRATION_REQUIRED');
            if (!currentOnly) await this.validate(shouldContinue);
            if (!shouldContinue()) return;
            const engine = this.engineForTask();
            if (currentOnly) {
              const current = await this.io.current(this.profile);
              if (current?.status === 'auth')
                throw recoveryError('登录已失效，请在来源页重新登录', 'AUTH_REQUIRED');
              const chapter =
                current?.status === 'ok' && cleanChapter(current.chapter, this.profile);
              if (!chapter)
                throw new Error(current?.error || '无法确认当前章节，请先在来源页选择章节');
              if (!shouldContinue()) return;
              engine.merge([chapter]);
              await engine.run({ chapterKey: chapter.key });
            } else await engine.run();
          } catch (error) {
            this.task.status =
              error.code === 'CALIBRATION_REQUIRED' ? 'needs_calibration' : 'paused';
            if (error.code !== 'CANCELLED') {
              this.task.recovery = { ...classifyRecoveryError(error), scope: 'task' };
              pushFault(this.task, faultOf(error, 'resume-source'));
              this.fail(error);
            }
          } finally {
            if (!shouldContinue()) {
              this.task.autoRecovery = {
                ...this.task.autoRecovery,
                enabled: false,
                nextAttemptAt: null,
              };
              if (this.task.status !== 'finished') this.task.status = 'paused';
            } else if (this.initialized && !currentOnly && taskHasRetryableWork(this.task)) {
              this.task.status = 'retry_wait';
              this.task.autoRecovery = {
                ...scheduleRecovery(this.task, savedBefore),
                sourceTabId: this.tabId,
              };
            } else
              this.task.autoRecovery = {
                ...this.task.autoRecovery,
                enabled: false,
                nextAttemptAt: null,
              };
            await this.store.saveTask(this.task);
          }
        }),
      );
    } catch (error) {
      // Without the task lock we cannot write a pause to storage. Disable only
      // this session's timer so a stale deadline cannot become a tight loop.
      if (this.task)
        this.task.autoRecovery = { ...this.task.autoRecovery, enabled: false, nextAttemptAt: null };
      this.fail(error);
    } finally {
      this.busy = false;
      this.emit();
      if (!this.disposed && !this.closed && !this.retryClock.running) this.retryClock.refresh();
    }
  }
  adopt(task, profile) {
    this.assertDocument();
    if (this.busy) throw new Error('正在采集，暂停后才能更换规则');
    const validated = validateProfile(profile);
    if (!task || task.profileId !== validated.id || task.profileRevision !== validated.revision)
      throw new Error('任务与校准规则不匹配');
    this.generation++;
    this.retryClock.dispose();
    this.profile = validated;
    this.task = task;
    this.draft = null;
    this.task.profile = this.profile;
    if (task.validation?.signature !== ruleSignature(this.profile)) delete task.validation;
    this.initialized = hasReusableRegions(this.profile, this.task);
    this.deleted = false;
    this.error = !this.initialized
      ? '目录或正文尚未完成校准；默认正文提取需先通过两个不同章节验证'
      : !this.task.queue.length
        ? emptyDirectoryMessage(this.task)
        : '';
    if (this.error) {
      this.task.status = 'needs_calibration';
      this.task.autoRecovery = { ...this.task.autoRecovery, enabled: false, nextAttemptAt: null };
    } else if (this.task.status === 'needs_calibration') this.task.status = 'ready';
    this.emit();
    this.retryClock.refresh();
  }
  async refresh() {
    if (this.purpose !== 'document' || this.busy || !this.task || this.disposed) return;
    const generation = this.generation;
    const current = this.task;
    const task = await this.store.loadTask(current.taskId);
    const deleted =
      !task &&
      (Boolean(current.storageRevision) ||
        Boolean(await this.store.getSetting('deleted-task:' + current.taskId)));
    if (this.busy || generation !== this.generation || this.disposed) return;
    // A calibrated draft can be adopted before its first durable checkpoint.
    // Missing storage alone is not evidence that the user deleted that draft.
    if (!task && !deleted) return;
    if (!task) {
      this.deleted = true;
      this.error = '任务已从资料库删除，已停止此来源；如需恢复请导入档案';
      this.task.autoRecovery = { ...this.task.autoRecovery, enabled: false, nextAttemptAt: null };
      this.retryClock.dispose();
    } else {
      if (this.deleted) this.error = '';
      this.deleted = false;
      this.task = task;
      this.profile = task.profile;
      this.retryClock.refresh();
    }
    this.emit();
  }
  async pause() {
    if (this.purpose !== 'document') {
      this.emit();
      return;
    }
    this.generation++;
    this.retryClock.dispose();
    this.engine?.pause();
    if (this.task)
      this.task.autoRecovery = { ...this.task.autoRecovery, enabled: false, nextAttemptAt: null };
    this.emit();
    if (this.busy || !this.task) return;
    try {
      await this.lock('task:' + this.task.taskId, async () => {
        await this.reload();
        this.task.autoRecovery = { ...this.task.autoRecovery, enabled: false, nextAttemptAt: null };
        if (this.task.status !== 'finished') this.task.status = 'paused';
        await this.store.saveTask(this.task);
      });
    } catch (error) {
      this.fail(error);
    }
    this.emit();
  }
  close() {
    this.closed = true;
    this.error = '来源标签页已关闭，已停止采集；已保存章节仍保留';
    return this.pause();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.retryClock.dispose();
    this.engine?.pause();
  }
}
