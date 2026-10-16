/** IndexedDB is the authority. Every checkpoint carries an optimistic revision. */
const DB = 'security-manual-importer-v1';
const CHANNEL = 'manualdock:tasks';

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tasks', { keyPath: 'taskId' });
      request.result.createObjectStore('pages', { keyPath: ['taskId', 'key'] });
      request.result.createObjectStore('profiles', { keyPath: 'id' });
      request.result.createObjectStore('settings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(stores, mode, work) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let failure;
      const abort = (error) => {
        failure = error;
        tx.abort();
      };
      const value = work(tx, abort);
      tx.oncomplete = () => resolve(typeof value === 'function' ? value() : value);
      tx.onerror = () => reject(failure || tx.error);
      tx.onabort = () => reject(failure || tx.error || new Error('保存中断'));
    });
  } finally {
    db.close();
  }
}
const pageRange = (id) => IDBKeyRange.bound([id, ''], [id, '\uffff']);
function notify(taskId, type) {
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ taskId, type });
  channel.close();
}
export function subscribeTasks(listener) {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => listener(event.data);
  return () => channel.close();
}

async function writeTask(
  task,
  { pageKey = null, whole = false, restore = false, shouldContinue = null } = {},
) {
  const revision = await transaction(['tasks', 'pages', 'settings'], 'readwrite', (tx, abort) => {
    const tasks = tx.objectStore('tasks'),
      settings = tx.objectStore('settings');
    const tombstone = settings.get('deleted-task:' + task.taskId);
    const current = tasks.get(task.taskId);
    let next;
    current.onsuccess = () => {
      if (shouldContinue && !shouldContinue())
        return abort(
          Object.assign(new Error('扫描已暂停，未保存新的目录结果'), { code: 'CANCELLED' }),
        );
      if (tombstone.result && !restore)
        return abort(new Error('任务已删除，停止写入；如需恢复请导入档案'));
      const actual = current.result?.storageRevision || 0;
      if (actual !== (task.storageRevision || 0))
        return abort(new Error('任务已更新，保存冲突；请刷新后继续'));
      next = actual + 1;
      const { pages = {}, ...metadata } = task;
      tasks.put({ ...metadata, storageRevision: next });
      const store = tx.objectStore('pages');
      if (whole) {
        store.delete(pageRange(task.taskId));
        for (const [key, page] of Object.entries(pages))
          store.put({ taskId: task.taskId, key, page });
      } else if (pageKey && pages[pageKey])
        store.put({ taskId: task.taskId, key: pageKey, page: pages[pageKey] });
      if (restore) settings.delete('deleted-task:' + task.taskId);
    };
    return () => next;
  });
  task.storageRevision = revision;
  notify(task.taskId, 'saved');
}
export function saveTask(task, pageKey = null, { shouldContinue = null } = {}) {
  return writeTask(task, { pageKey, shouldContinue });
}
export function saveWholeTask(task) {
  return writeTask(task, { whole: true });
}
/** Only explicit archive import can clear a deletion tombstone. */
export function restoreWholeTask(task) {
  return writeTask(task, { whole: true, restore: true });
}
export function loadTask(taskId) {
  return transaction(['tasks', 'pages'], 'readonly', (tx) => {
    const task = tx.objectStore('tasks').get(taskId);
    const pages = tx.objectStore('pages').getAll(pageRange(taskId));
    return () =>
      task.result
        ? {
            ...task.result,
            pages: Object.fromEntries(pages.result.map((row) => [row.key, row.page])),
          }
        : null;
  });
}
export function listTasks() {
  return transaction(['tasks'], 'readonly', (tx) => {
    const request = tx.objectStore('tasks').getAll();
    return () => request.result;
  });
}
export function saveProfile(profile) {
  return transaction(['profiles'], 'readwrite', (tx) => {
    tx.objectStore('profiles').put(profile);
  });
}
export function loadProfiles() {
  return transaction(['profiles'], 'readonly', (tx) => {
    const request = tx.objectStore('profiles').getAll();
    return () => request.result;
  });
}
export function setSetting(key, value) {
  return transaction(['settings'], 'readwrite', (tx) => {
    tx.objectStore('settings').put(value, key);
  });
}
export function getSetting(key) {
  return transaction(['settings'], 'readonly', (tx) => {
    const request = tx.objectStore('settings').get(key);
    return () => request.result;
  });
}
export function listSettings() {
  return transaction(['settings'], 'readonly', (tx) => {
    const request = tx.objectStore('settings').getAllKeys();
    return () => request.result;
  });
}
export function deleteSetting(key) {
  return transaction(['settings'], 'readwrite', (tx) => {
    tx.objectStore('settings').delete(key);
  });
}
/** Remove body, metadata and retry bindings together; keep recognition rules. */
export async function deleteTask(taskId) {
  await transaction(['tasks', 'pages', 'settings'], 'readwrite', (tx) => {
    tx.objectStore('tasks').delete(taskId);
    tx.objectStore('pages').delete(pageRange(taskId));
    const settings = tx.objectStore('settings');
    settings.put(true, 'deleted-task:' + taskId);
    const cursor = settings.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (String(row.key).startsWith('recovery-tab:') && row.value === taskId) row.delete();
      row.continue();
    };
  });
  notify(taskId, 'deleted');
}
