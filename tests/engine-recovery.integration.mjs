// Real-IndexedDB recovery / data-consistency tests for ImportEngine.
// These exercise the actual engine + task-store persistence layer against
// fake-indexeddb (a faithful IndexedDB implementation), NOT jsdom DOM mocks.
// Verification level: Node + fake-indexeddb (real IndexedDB semantics).
// The real MV3 extension UI (panel tabId rebind, Web Locks) is covered by the
// browser E2E where the environment allows it; see the delivery report.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { ImportEngine, createTask } from '../extension/engine.js';
import { saveTask, loadTask } from '../extension/task-store.js';

const profile = {
  id: 'p1',
  revision: 1,
  entry: 'https://manual.example.com/',
  origin: 'https://manual.example.com',
  pathPrefix: '/',
};

function makeIo() {
  return {
    profile,
    discover: async () => ({ status: 'ok', items: [] }),
    capture: async () => ({
      status: 'ok',
      text: 'x',
      html: '<p>x</p>',
      navigationProof: { verified: true },
    }),
    save: async (task, key) => saveTask(task, key),
    captureLog: {},
  };
}

const keys = (n) => Array.from({ length: n }, (_, i) => 'ch' + (i + 1));
function seed(task, n) {
  for (const k of keys(n))
    task.queue.push({
      key: k,
      title: k,
      status: 'pending',
      locator: { type: 'link', href: '/' + k },
    });
}

test('breakpoint recovery: capture 4/10, close control page, reopen and continue 5-10 without overwriting', async () => {
  const io = makeIo();
  const task = createTask(profile, 'Breakpoint', '1');
  seed(task, 10);
  const a = new ImportEngine(task, io);
  a.scan = async () => true;
  let captured = 0;
  io.capture = async (chapter) => {
    io.captureLog[chapter.key] = (io.captureLog[chapter.key] || 0) + 1;
    if (++captured === 4) a.pause();
    return {
      status: 'ok',
      text: 'content for ' + chapter.key,
      html: '<p>content for ' + chapter.key + '</p>',
      navigationProof: { verified: true },
    };
  };
  await a.run();
  let saved = await loadTask(task.taskId);
  assert.equal(saved.queue.filter((c) => c.status === 'captured').length, 4);
  assert.equal(saved.queue.filter((c) => c.status === 'pending').length, 6);
  assert.equal(saved.status, 'paused');
  assert.deepEqual(Object.keys(saved.pages).sort(), ['ch1', 'ch2', 'ch3', 'ch4']);

  // reopen with a fresh engine instance (simulates a new tab / closed control page)
  const reloaded = await loadTask(task.taskId);
  const b = new ImportEngine(reloaded, io);
  b.scan = async () => true;
  await b.run();
  saved = await loadTask(task.taskId);
  assert.equal(saved.status, 'finished');
  assert.equal(Object.keys(saved.pages).length, 10);
  assert.deepEqual(Object.keys(saved.pages).sort(), keys(10).sort());
  // first four were NOT re-collected and their content is intact
  for (const k of ['ch1', 'ch2', 'ch3', 'ch4'])
    assert.equal(saved.pages[k].text, 'content for ' + k);
  assert.equal(io.captureLog['ch1'], 1, 'chapter 1 captured exactly once');
  assert.equal(io.captureLog['ch5'], 1);
  for (const c of saved.queue) assert.ok(saved.pages[c.key], 'missing page for ' + c.key);
});

test('storage failure stops the run and never marks the chapter captured', async () => {
  const io = makeIo();
  let storageBroken = false;
  const realSave = io.save;
  io.save = async (task, key) => {
    if (key !== null && storageBroken) throw new Error('IndexedDB write failed');
    return realSave(task, key);
  };
  const task = createTask(profile, 'Storage', '1');
  seed(task, 10);
  const a = new ImportEngine(task, io);
  a.scan = async () => true;
  io.capture = async (chapter) => {
    io.captureLog[chapter.key] = (io.captureLog[chapter.key] || 0) + 1;
    if (chapter.key === 'ch5') storageBroken = true;
    return {
      status: 'ok',
      text: 'x' + chapter.key,
      html: '<p>x' + chapter.key + '</p>',
      navigationProof: { verified: true },
    };
  };
  await a.run();
  const saved = await loadTask(task.taskId);
  assert.equal(saved.queue.find((c) => c.key === 'ch5').status, 'failed');
  assert.equal(saved.queue.find((c) => c.key === 'ch5').error.includes('存档失败'), true);
  assert.equal(saved.recovery && saved.recovery.reason, 'storage');
  for (const k of ['ch6', 'ch7', 'ch8', 'ch9', 'ch10'])
    assert.equal(io.captureLog[k], undefined, k + ' must not be collected after a storage failure');
  assert.equal(saved.pages['ch5'], undefined, 'failed chapter body must not be persisted');
  assert.deepEqual(Object.keys(saved.pages).sort(), ['ch1', 'ch2', 'ch3', 'ch4']);
  assert.equal(a.task.pages['ch5'], undefined, 'in-memory record must be reverted too');
});

test('a task left with a permanent chapter failure is reported paused, never finished', async () => {
  const io = makeIo();
  const task = createTask(profile, 'Finish', '1');
  for (const k of ['ch1', 'bad', 'ch2']) task.queue.push({ key: k, title: k, status: 'pending' });
  io.capture = async (chapter) => {
    io.captureLog[chapter.key] = (io.captureLog[chapter.key] || 0) + 1;
    if (chapter.key === 'bad')
      return {
        status: 'error',
        error: 'could not load body',
        diagnostics: { reason: 'navigation' },
      };
    return {
      status: 'ok',
      text: 'x' + chapter.key,
      html: '<p>x' + chapter.key + '</p>',
      navigationProof: { verified: true },
    };
  };
  const a = new ImportEngine(task, io);
  a.scan = async () => true;
  await a.run();
  const saved = await loadTask(task.taskId);
  assert.equal(saved.status, 'paused');
  assert.notEqual(saved.status, 'finished');
  assert.equal(saved.queue.find((c) => c.key === 'bad').status, 'failed');
  assert.equal(saved.queue.find((c) => c.key === 'ch1').status, 'captured');
  assert.equal(saved.queue.find((c) => c.key === 'ch2').status, 'captured');
});

test('two engines for the same task in one context cannot both run', async () => {
  const io = makeIo();
  let resolveCh1 = null;
  io.capture = async (chapter) => {
    io.captureLog[chapter.key] = (io.captureLog[chapter.key] || 0) + 1;
    if (chapter.key === 'ch1') await new Promise((r) => (resolveCh1 = r));
    return {
      status: 'ok',
      text: 'x' + chapter.key,
      html: '<p>' + chapter.key + '</p>',
      navigationProof: { verified: true },
    };
  };
  const task = createTask(profile, 'Double', '1');
  seed(task, 3);
  const a = new ImportEngine(task, io);
  a.scan = async () => true;
  const b = new ImportEngine(task, io);
  b.scan = async () => true;
  const pA = a.run();
  const pB = b.run();
  await new Promise((r) => setTimeout(r, 50)); // let B attempt to run if unguarded
  resolveCh1(); // release A's first capture so it can finish
  await pA;
  await pB;
  const saved = await loadTask(task.taskId);
  assert.equal(
    saved.queue.filter((c) => c.status === 'captured').length,
    3,
    'only one engine should have collected',
  );
});
