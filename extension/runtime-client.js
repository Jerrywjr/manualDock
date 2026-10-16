import { SourceSession } from './session.js';
import { loadTask } from './task-store.js';
const TYPE = 'manualdock:runtime';
async function request(action, tabId, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type: TYPE, action, tabId, ...extra });
  if (!reply || reply.error) throw new Error(reply?.error || '后台未响应，请重新加载扩展');
  return reply.value;
}
export const listBackgroundSources = () => request('list');
export function createRemoteSession(options) {
  // Reuse the view model and local page-picking IO, but never its task scheduler.
  const session = new SourceSession(options);
  let updates = Promise.resolve();
  const apply = (snapshot) => {
    updates = updates
      .catch(() => {})
      .then(async () => {
        if (!snapshot || session.disposed) return;
        const { state, task, purpose, ...fields } = snapshot;
        const saved = task?.taskId ? await loadTask(task.taskId) : null;
        Object.assign(session, fields, {
          task: task ? { ...task, pages: saved?.pages || {} } : null,
        });
        session.emit();
      });
    return updates;
  };
  const receive = (message, sender) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.type !== TYPE + ':changed' ||
      message.source?.tabId !== session.tabId
    )
      return;
    void apply(message.source).catch((error) => session.fail(error));
  };
  chrome.runtime.onMessage.addListener(receive);
  session.connect = async () =>
    apply(await request('connect', session.tabId, { purpose: session.purpose }));
  for (const method of [
    'initialize',
    'scanDirectory',
    'adopt',
    'refresh',
    'start',
    'captureCurrent',
    'pause',
  ])
    session[method] = async (...args) => apply(await request(method, session.tabId, { args }));
  session.close = async () => {
    // tabs.onRemoved in the background owns the durable stop. Sending another
    // pause from this view races that stop for the same task lock.
    session.closed = true;
    session.error = '来源标签页已关闭，已停止采集；已保存章节仍保留';
    session.emit();
  };
  session.remove = () => request('remove', session.tabId);
  session.dispose = () => {
    session.disposed = true;
    session.retryClock.dispose();
    chrome.runtime.onMessage.removeListener(receive);
  };
  return session;
}
export function createRemoteRotationController({ onChange }) {
  const receive = (message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === TYPE + ':changed' && message.rotation)
      onChange(message.rotation.tabId, message.rotation.state);
  };
  chrome.runtime.onMessage.addListener(receive);
  return {
    start: (tabId, config) => request('rotation:start', tabId, { config }),
    stop: (tabId) => request('rotation:stop', tabId),
    config: (tabId) => request('rotation:config', tabId),
    snapshot: (tabId) => request('rotation:snapshot', tabId),
    dispose: () => chrome.runtime.onMessage.removeListener(receive),
  };
}
