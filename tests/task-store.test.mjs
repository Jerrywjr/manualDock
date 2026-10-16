import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import * as store from '../extension/task-store.js';
Object.assign(globalThis, { indexedDB, IDBKeyRange });
const sample = () => ({
  taskId: crypto.randomUUID(),
  queue: [],
  pages: { a: { text: 'A' } },
  sourceKind: 'web',
});

test('stale task snapshots cannot overwrite a newer checkpoint', async () => {
  const task = sample();
  await store.saveWholeTask(task);
  const stale = await store.loadTask(task.taskId);
  task.status = 'running';
  await store.saveTask(task);
  stale.status = 'paused';
  await assert.rejects(store.saveTask(stale), /已更新|冲突/);
  assert.equal((await store.loadTask(task.taskId)).status, 'running');
});
test('whole task replacement removes obsolete pages atomically', async () => {
  const task = sample();
  await store.saveWholeTask(task);
  task.pages = { b: { text: 'B' } };
  await store.saveWholeTask(task);
  assert.deepEqual(Object.keys((await store.loadTask(task.taskId)).pages), ['b']);
});
test('delete removes recovery links and rejects subsequent stale writes', async () => {
  const task = sample();
  await store.saveWholeTask(task);
  await store.setSetting('recovery-tab:1', task.taskId);
  await store.setSetting('rotation:keep', { targets: [] });
  await store.deleteTask(task.taskId);
  assert.equal(await store.loadTask(task.taskId), null);
  assert.equal(await store.getSetting('recovery-tab:1'), undefined);
  await assert.rejects(store.saveTask(task), /删除/);
  assert.equal(await store.loadTask(task.taskId), null);
  assert.deepEqual(await store.getSetting('rotation:keep'), { targets: [] });
});

test('a cancelled checkpoint does not update metadata, pages or its storage revision', async () => {
  const task = sample();
  await store.saveWholeTask(task);
  const before = await store.loadTask(task.taskId);
  task.queue.push({ key: 'pending-discovery' });
  task.pages.a = { text: 'replacement that must not commit' };
  await assert.rejects(store.saveTask(task, 'a', { shouldContinue: () => false }), {
    code: 'CANCELLED',
  });
  assert.equal(task.storageRevision, before.storageRevision);
  assert.deepEqual(await store.loadTask(task.taskId), before);
});
