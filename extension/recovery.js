// 故障分类与恢复辅助：classifyRecoveryError 决定能否重试，scheduleRecovery 计算下次时间。
// resetRetryableChapters 只重置可重试章节；collectionMessage 生成人能读懂的停止原因。
// 未展开内容不会仅因延长预算而成为网络故障，仍需明确重试或检查来源页面。
export const RETRY_INTERVAL_MS = 3 * 60 * 1000;
const RETRY_DELAYS = [5000, 15000, 30000, 60000, RETRY_INTERVAL_MS];
export const savedChapterCount = (task) =>
  (task.queue || []).filter((chapter) => ['captured', 'review'].includes(chapter.status)).length;

/** Persist the backoff with the task; useful progress resets consecutive failures. */
export function scheduleRecovery(task, savedBefore, now = Date.now()) {
  const prior = task.autoRecovery || {};
  const failures =
    savedChapterCount(task) > savedBefore
      ? 0
      : Math.max(0, Math.trunc(Number(prior.failures) || 0));
  const auth =
    task.recovery?.reason === 'auth' || task.queue?.some((c) => c.status === 'waiting_login');
  const delay = auth
    ? RETRY_INTERVAL_MS
    : RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)];
  return {
    ...prior,
    enabled: true,
    failures: Math.min(failures + 1, RETRY_DELAYS.length),
    nextAttemptAt: now + delay,
  };
}

// Only failures that can change without altering a calibration rule are retried.
export function classifyRecoveryError(value) {
  const message = redact(
    String(value?.message || value?.error || value?.diagnostics?.reason || value || ''),
  );
  if (value?.code === 'STORAGE_ERROR') return { retryable: false, reason: 'storage', message };
  if (value?.status === 'auth' || value?.code === 'AUTH_REQUIRED')
    return { retryable: true, reason: 'auth', message };
  if (
    /原标签页已关闭|离开手册|其他来源|不同源|无法唯一|示例正文相同|请选取两个|重新点选|重新校准|permission|not allowed|access.*denied|无法确认错误标签页/i.test(
      message,
    ) &&
    !/chrome-error:\/\//i.test(message)
  )
    return { retryable: false, reason: 'intervention', message };
  if (
    value?.code === 'NETWORK_ERROR' ||
    /Failed to fetch|fetch failed|NetworkError|network (?:error|request failed)|net::ERR_|ERR_(?:INTERNET_DISCONNECTED|CONNECTION_[A-Z_]+|NETWORK_[A-Z_]+|NAME_NOT_RESOLVED)|chrome-error:\/\/|Frame with ID \d+ is showing error page|offline|网络连接|网络不可用|网络错误|连接断开/i.test(
      message,
    )
  )
    return { retryable: true, reason: 'network', message };
  if (
    value?.code === 'LOAD_TIMEOUT' ||
    /timeout|timed out|超时|45秒内未确认章节和正文完成切换/i.test(message)
  )
    return { retryable: true, reason: 'timeout', message };
  if (
    /execution context (?:was )?(?:destroyed|removed)|frame (?:was )?removed|context invalidated|unload/i.test(
      message,
    )
  )
    return { retryable: true, reason: 'navigation', message };
  return { retryable: false, reason: 'intervention', message };
}

export function recoveryError(message, code) {
  return Object.assign(new Error(message), { code });
}

// A page-side failure used to collapse into a bare message string, so the real
// cause was unrecoverable once it crossed chrome.scripting.executeScript(). This
// keeps only what identifies a fault (type, stage, chapter, call site) and runs
// every message/stack through redact() so credentials never reach the error log.

// Strips secrets that can appear in error messages or stack traces: tokens in URL
// query/fragment strings, Authorization/Bearer/Cookie headers, and key=value pairs
// such as token=, api_key=, password=. Chapter identity (chapterKey/chapterTitle)
// and the call-site file:line are preserved on purpose.
const SENSITIVE_KEY =
  /(?:token|api[_-]?key|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|authorization|auth|session[_-]?id|set[_-]?cookie|cookie)/i;
export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  // Drop query strings and fragments from URLs; they carry tokens/session ids.
  s = s.replace(/(https?:\/\/[^\s"'<>?#]+)(\?[^?\s"'<>]*)?(#[^\s"'<>]*)?/g, (m, base) => base);
  s = s.replace(/(Authorization\s*:\s*(?:Bearer\s+)?)\S+/gi, '$1<redacted>');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
  s = s.replace(/(?:Set-)?Cookie\s*:\s*\S+/gi, (m) => m.replace(/\S+$/, '<redacted>'));
  s = s.replace(new RegExp('(' + SENSITIVE_KEY.source + '\\s*[=:]\\s*)\\S+', 'gi'), '$1<redacted>');
  return s;
}

export function faultOf(error, stage, chapter) {
  // Prefer the fault carried across the script boundary: its stack points at the
  // frame that actually failed, unlike the local wrapper's stack.
  const carried = error?.fault && typeof error.fault === 'object' ? error.fault : null;
  const source =
    carried || (error && typeof error === 'object' ? error : { message: String(error ?? '') });
  return {
    name: String(source.name || 'Error').slice(0, 100),
    message: redact(String(source.message || '').slice(0, 500)),
    stack: redact(
      String(source.stack || '')
        .split('\n')
        .slice(0, 8)
        .join('\n'),
    ).slice(0, 1200),
    stage: String(carried?.stage || stage || 'unknown').slice(0, 60),
    chapterKey: chapter?.key == null ? null : String(chapter.key).slice(0, 200),
    chapterTitle: chapter?.title == null ? null : String(chapter.title).slice(0, 200),
    at: new Date().toISOString(),
  };
}

/** Keeps the newest faults on the task so they survive closing the console.
 *  Re-applies redact() as a backstop so a fault that skipped errShape/faultOf
 *  still cannot leak a credential into the stored/displayed log. */
export function pushFault(task, fault, limit = 50) {
  if (!task || !fault) return task;
  const clean = {
    ...fault,
    message: redact(String(fault.message || '')),
    stack: redact(String(fault.stack || '')),
  };
  const log = Array.isArray(task.errorLog) ? task.errorLog : [];
  task.errorLog = [clean, ...log].slice(0, limit);
  return task;
}

export function resetRetryableChapters(task) {
  let count = 0;
  for (const chapter of task.queue || []) {
    if (
      chapter.status === 'waiting_login' ||
      (chapter.status === 'failed' && chapter.recovery?.retryable === true)
    ) {
      chapter.status = 'pending';
      delete chapter.error;
      delete chapter.recovery;
      count++;
    }
  }
  return count;
}

export function taskHasRetryableWork(task) {
  if (
    !task ||
    task.sourceKind !== 'web' ||
    (task.recovery?.retryable === false && task.recovery.scope !== 'chapter')
  )
    return false;
  const queue = task.queue || [];
  if (
    queue.some(
      (c) =>
        c.status === 'waiting_login' || (c.status === 'failed' && c.recovery?.retryable === true),
    )
  )
    return true;
  return (
    task.recovery?.retryable === true &&
    (!queue.length || queue.some((c) => ['pending', 'processing'].includes(c.status)))
  );
}

/** Explicit resume can retry interrupted, unsaved chapters after source recovery succeeds. */
export function resetInterruptedChapters(task) {
  for (const chapter of task.queue || []) {
    if (
      chapter.status === 'failed' &&
      chapter.recovery?.scope === 'task' &&
      !task.pages?.[chapter.key]
    ) {
      chapter.status = 'pending';
      delete chapter.error;
      delete chapter.recovery;
    }
  }
}

/** Persistent explanation for the collection controls; redacts credentials before display. */
export function collectionMessage(task, sourceError = '') {
  if (!task || task.status === 'running') return sourceError ? redact(sourceError) : '';
  const failed = (task.queue || []).filter((c) => c.status === 'failed');
  const reviews = (task.queue || []).filter((c) => c.status === 'review');
  const reason = redact(sourceError || task.recovery?.message || failed.at(-1)?.error || '');
  const counts = `${failed.length} 章失败，${reviews.length} 章正文待核对`;
  if (reason) {
    const action = task.autoRecovery?.enabled
      ? '将自动重试；也可手动暂停。'
      : task.recovery?.reason === 'storage'
        ? '请检查本机存储；恢复后再继续。'
        : task.recovery?.scope === 'task'
          ? '请查看来源页，必要时重新登录或校准，再继续。'
          : '其余章节已继续处理；可重试问题项。';
    return `${task.status === 'retry_wait' ? '等待恢复' : '采集未完成'}：${reason}。${counts}。${action}`;
  }
  return reviews.length ? `${counts}。重复正文已保留，不会因此停止其他章节。` : '';
}
