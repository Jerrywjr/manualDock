export const RETRY_INTERVAL_MS = 3 * 60 * 1000;

// Only failures that can change without altering a calibration rule are retried.
export function classifyRecoveryError(value) {
  const message = String(value?.message || value?.error || value?.diagnostics?.reason || value || '');
  if (value?.status === 'auth' || value?.code === 'AUTH_REQUIRED') return {retryable:true,reason:'auth'};
  if (/原标签页已关闭|离开手册|其他来源|不同源|无法唯一|示例正文相同|请选取两个|重新点选|重新校准|permission|not allowed|access.*denied|无法确认错误标签页/i.test(message) && !/chrome-error:\/\//i.test(message)) return {retryable:false,reason:'intervention'};
  if (value?.code === 'NETWORK_ERROR' || /Failed to fetch|fetch failed|NetworkError|network (?:error|request failed)|net::ERR_|ERR_(?:INTERNET_DISCONNECTED|CONNECTION_[A-Z_]+|NETWORK_[A-Z_]+|NAME_NOT_RESOLVED)|chrome-error:\/\/|Frame with ID \d+ is showing error page|offline|网络连接|网络不可用|网络错误|连接断开/i.test(message)) return {retryable:true,reason:'network'};
  if (value?.code === 'LOAD_TIMEOUT' || /timeout|timed out|超时|45秒内未确认章节和正文完成切换/i.test(message)) return {retryable:true,reason:'timeout'};
  if (/execution context (?:was )?(?:destroyed|removed)|frame (?:was )?removed|context invalidated|unload/i.test(message)) return {retryable:true,reason:'navigation'};
  return {retryable:false,reason:'intervention'};
}

export function recoveryError(message, code) {
  return Object.assign(new Error(message), {code});
}

// A page-side failure used to collapse into a bare message string, so the real
// cause was unrecoverable once it crossed chrome.scripting.executeScript(). This
// keeps only what identifies a fault, never page content, form values, cookies,
// tokens or credentials.
export function faultOf(error, stage, chapter) {
  // Prefer the fault carried across the script boundary: its stack points at the
  // frame that actually failed, unlike the local wrapper's stack.
  const carried = error?.fault && typeof error.fault === 'object' ? error.fault : null;
  const source = carried || (error && typeof error === 'object' ? error : {message: String(error ?? '')});
  return {
    name: String(source.name || 'Error').slice(0, 100),
    message: String(source.message || '').slice(0, 500),
    stack: String(source.stack || '').split('\n').slice(0, 8).join('\n').slice(0, 1200),
    stage: String(carried?.stage || stage || 'unknown').slice(0, 60),
    chapterKey: chapter?.key == null ? null : String(chapter.key).slice(0, 200),
    chapterTitle: chapter?.title == null ? null : String(chapter.title).slice(0, 200),
    at: new Date().toISOString(),
  };
}

/** Keeps the newest faults on the task so they survive closing the console. */
export function pushFault(task, fault, limit = 50) {
  if (!task || !fault) return task;
  const log = Array.isArray(task.errorLog) ? task.errorLog : [];
  task.errorLog = [fault, ...log].slice(0, limit);
  return task;
}

export function resetRetryableChapters(task) {
  let count=0;
  for (const chapter of task.queue || []) {
    if (chapter.status === 'waiting_login' || (chapter.status === 'failed' && chapter.recovery?.retryable === true)) {
      chapter.status='pending';delete chapter.error;delete chapter.recovery;count++;
    }
  }
  return count;
}

export function taskHasRetryableWork(task) {
  if (!task || task.sourceKind !== 'web' || task.recovery?.retryable === false) return false;
  const queue=task.queue || [];
  if (queue.some(c => c.status === 'waiting_login' || (c.status === 'failed' && c.recovery?.retryable === true))) return true;
  return task.recovery?.retryable === true && (!queue.length || queue.some(c => ['pending','processing'].includes(c.status)));
}
