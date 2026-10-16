import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderLibrary, libraryPageSize } from '../extension/library-view.js';

test('library view renders escaped metadata and delegates actions without owning storage', (t) => {
  const dom = new JSDOM('<ul id="task-list"></ul>');
  t.after(() => dom.window.close());
  const calls = [];
  const task = {
    taskId: 'saved',
    product: '<img onerror=bad()>',
    queue: [{ status: 'captured' }],
    sourceKind: 'web',
  };
  const before = structuredClone(task);
  renderLibrary({
    document: dom.window.document,
    items: [task],
    taskState: () => '已暂停',
    stamp: () => '-',
    ago: () => '-',
    onOpen: (t) => calls.push(['open', t]),
    onExport: (t) => calls.push(['export', t]),
    onDelete: (t) => calls.push(['delete', t]),
  });
  const list = dom.window.document.querySelector('#task-list');
  assert.equal(list.querySelector('img'), null);
  assert.match(list.textContent, /已保存 1\/1 章/);
  list.querySelectorAll('button').forEach((b) => b.click());
  assert.deepEqual(
    calls.map(([action]) => action),
    ['open', 'export', 'delete'],
  );
  assert.ok(calls.every(([, received]) => received === task));
  assert.deepEqual(task, before);
  renderLibrary({ document: dom.window.document, items: [] });
  assert.equal(list.querySelectorAll('button').length, 0);
  assert.match(list.textContent, /还没有保存的任务/);
});

test('library page capacity follows CSS rows and columns without changing selection', (t) => {
  const dom = new JSDOM('<ul id="task-list" style="--task-row-height:96;--task-columns:2"></ul>');
  t.after(() => dom.window.close());
  const list = dom.window.document.getElementById('task-list');
  Object.defineProperty(list, 'clientHeight', { value: 210 });
  assert.equal(libraryPageSize(dom.window.document), 4);
  list.style.setProperty('--task-columns', '1');
  assert.equal(libraryPageSize(dom.window.document), 2);
});
