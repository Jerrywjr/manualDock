import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { SourceSession } from '../extension/session.js';
import { createTask } from '../extension/engine.js';
import { ruleSignature, validateProfile } from '../extension/profiles.js';
import * as taskStore from '../extension/task-store.js';
const { createBackgroundRuntime } = await import('../extension/background-runtime.js').catch(
  (e) => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return {};
  },
);
const event = () => {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
};
function setup({ store: backingStore, createSession } = {}) {
  const saved = new Map(),
    sessions = [],
    rotations = new Map();
  const store = backingStore || {
    getSetting: async (k) => structuredClone(saved.get(k)),
    setSetting: async (k, v) => saved.set(k, structuredClone(v)),
  };
  const chrome = {
    runtime: {
      id: 'test',
      onMessage: event(),
      sendMessage: async () => {},
      getPlatformInfo: async () => ({}),
    },
    tabs: { onRemoved: event() },
    alarms: { onAlarm: event(), create: async () => {} },
  };
  const factory = (options) => {
    const s = {
      ...options,
      task: null,
      profile: null,
      busy: false,
      purpose: options.purpose,
      io: { tab: async () => ({ url: 'https://manual.test/docs' }) },
      getState() {
        return { busy: this.busy };
      },
      async connect() {
        this.connected = true;
      },
      async initialize() {
        this.initialized = true;
      },
      start() {
        this.busy = true;
        this.task = { taskId: 'task-1', pages: {}, autoRecovery: { enabled: true } };
        this.onChange({}, this);
        return new Promise(
          (resolve) =>
            (this.finish = () => {
              this.busy = false;
              resolve();
            }),
        );
      },
      async pause() {
        this.task.autoRecovery.enabled = false;
        this.finish();
        this.onChange({}, this);
      },
      dispose() {
        this.disposed = true;
      },
    };
    sessions.push(s);
    return s;
  };
  const rotationFactory = ({ onChange }) => ({
    async start(id, config, resume) {
      const state = { running: true, count: resume?.count || 0 };
      rotations.set(id, { config, state });
      onChange(id, state);
      return state;
    },
    async snapshot(id) {
      return rotations.get(id)?.state || { running: false };
    },
    async stop(id) {
      const state = { running: false };
      rotations.set(id, { state });
      onChange(id, state);
      return state;
    },
  });
  const create = () =>
    createBackgroundRuntime({
      chrome,
      store,
      createSession: createSession || factory,
      createRotation: rotationFactory,
      timers: {
        setInterval() {
          return 1;
        },
        clearInterval() {},
      },
    });
  return { create, sessions, saved, rotations, chrome };
}
test('reconnecting a refreshed panel retains the same running source and rotation', async () => {
  assert.equal(typeof createBackgroundRuntime, 'function');
  const h = setup(),
    host = h.create();
  await host.ready;
  await host.request({ action: 'connect', tabId: 1, purpose: 'document' });
  await host.request({ action: 'start', tabId: 1, args: [] });
  await host.request({ action: 'connect', tabId: 2, purpose: 'rotation' });
  await host.request({
    action: 'rotation:start',
    tabId: 2,
    config: { origin: 'https://manual.test', pathPrefix: '/docs', targets: [{ title: 'One' }] },
  });
  const reconnected = await host.request({ action: 'connect', tabId: 1, purpose: 'document' });
  assert.equal(reconnected.busy, true);
  assert.equal(h.sessions.filter((s) => s.tabId === 1).length, 1);
  assert.equal((await host.request({ action: 'rotation:snapshot', tabId: 2 })).running, true);
  assert.equal((await host.request({ action: 'list' })).length, 2);
  await host.request({ action: 'pause', tabId: 1, args: [] });
  assert.equal(h.sessions[0].task.autoRecovery.enabled, false);
  await host.request({ action: 'rotation:stop', tabId: 2 });
  assert.equal((await host.request({ action: 'rotation:snapshot', tabId: 2 })).running, false);
});
test('source registrations survive worker replacement; removed sources do not reappear', async () => {
  const h = setup(),
    first = h.create();
  await first.ready;
  await first.request({ action: 'connect', tabId: 1, purpose: 'document' });
  const second = h.create();
  await second.ready;
  assert.equal((await second.request({ action: 'list' })).length, 1);
  await second.request({ action: 'remove', tabId: 1 });
  const third = h.create();
  await third.ready;
  assert.equal((await third.request({ action: 'list' })).length, 0);
});

async function boundSource(t) {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const profile = validateProfile({
    schemaVersion: 1,
    id: 'bound-manual',
    revision: 1,
    adapterId: 'generic',
    name: 'Bound manual',
    entry: 'https://manual.test/docs',
    pathPrefix: '/docs',
    tocSelector: 'nav',
    contentSelector: 'main',
    hashMode: 'none',
    queryKeys: [],
    navigation: 'links',
    samples: [],
  });
  const task = createTask(profile);
  task.queue = ['one', 'two'].map((title, index) => ({
    key: 'url:https://manual.test/docs/' + title,
    url: 'https://manual.test/docs/' + title,
    title,
    status: index ? 'pending' : 'captured',
  }));
  task.pages[task.queue[0].key] = { text: 'Previously saved body', hash: 'original-body' };
  task.validation = { signature: ruleSignature(profile) };
  await taskStore.saveProfile(profile);
  await taskStore.saveTask(task, task.queue[0].key);
  const sessions = [],
    calls = { detect: 0, discover: 0 },
    io = {
      tab: async () => ({ id: 1, url: profile.entry, title: profile.name }),
      detect: async () => {
        calls.detect++;
        assert.fail('worker restoration must not recognize a new task');
      },
      discover: async () => {
        calls.discover++;
        assert.fail('worker restoration must not rescan the directory');
      },
    };
  const h = setup({
    store: taskStore,
    createSession: (options) => {
      const session = new SourceSession({
        ...options,
        io,
        store: taskStore,
        locks: { request: async (_name, _options, action) => action({}) },
      });
      sessions.push(session);
      return session;
    },
  });
  t.after(() => sessions.forEach((session) => session.dispose()));
  return { ...h, sessions, task, profile, io, calls };
}

test('worker replacement restores the original task after a failed directory rescan', async (t) => {
  const h = await boundSource(t),
    first = h.create();
  await first.ready;
  await first.request({ action: 'connect', tabId: 1, purpose: 'document' });
  await first.request({ action: 'initialize', tabId: 1, args: [{ taskId: h.task.taskId }] });
  const before = await taskStore.loadTask(h.task.taskId);
  h.io.discover = async () => ({ status: 'error', error: 'Directory matches multiple regions' });
  await assert.rejects(first.request({ action: 'scanDirectory', tabId: 1 }), /multiple regions/);
  await first.request({ action: 'connect', tabId: 1, purpose: 'document' });
  const saved = await taskStore.getSetting('background-runtime-v1');
  assert.equal(saved.sources[0].initialized, false);
  assert.equal(saved.sources[0].taskId, before.taskId);
  h.sessions[0].dispose();
  h.io.discover = async () => assert.fail('worker restoration must not rescan the directory');
  const second = h.create();
  await second.ready;
  const [restored] = await second.request({ action: 'list' });
  assert.equal(restored.task?.taskId, before.taskId);
  assert.equal(restored.initialized, true, restored.error);
  assert.deepEqual(restored.task.queue, before.queue);
  assert.deepEqual(restored.profile, before.profile);
  assert.deepEqual((await taskStore.loadTask(before.taskId)).pages, before.pages);
  assert.equal((await taskStore.listTasks()).length, 1);
  assert.deepEqual(h.calls, { detect: 0, discover: 0 });
});

for (const boundary of [
  'no-task',
  'missing-task',
  'outside-manual',
  'closed-tab',
  'rotation',
  'empty-queue',
  'missing-profile',
  'missing-regions',
  'invalid-samples',
])
  test(`worker replacement cannot adopt or create a task at the ${boundary} boundary`, async (t) => {
    const h = await boundSource(t);
    const descriptor = {
      tabId: 1,
      purpose: boundary === 'rotation' ? 'rotation' : 'document',
      initialized: false,
      taskId: h.task.taskId,
    };
    if (boundary === 'no-task') delete descriptor.taskId;
    if (boundary === 'missing-task') await taskStore.deleteTask(h.task.taskId);
    if (boundary === 'outside-manual')
      h.io.tab = async () => ({ id: 1, url: 'https://outside.test/docs' });
    if (boundary === 'closed-tab')
      h.io.tab = async () => {
        throw new Error('No tab with id: 1');
      };
    if (boundary === 'empty-queue') h.task.queue = [];
    if (boundary === 'missing-profile') delete h.task.profile;
    if (['missing-regions', 'invalid-samples'].includes(boundary)) {
      h.task.profile.contentSelector = '';
      if (boundary === 'invalid-samples') {
        h.task.profile.samples = [h.task.queue[0], h.task.queue[0]];
        h.task.validation.signature = ruleSignature(h.task.profile);
      }
    }
    if (['empty-queue', 'missing-profile', 'missing-regions', 'invalid-samples'].includes(boundary))
      await taskStore.saveTask(h.task);
    await taskStore.setSetting('background-runtime-v1', { sources: [descriptor] });
    const host = h.create();
    await host.ready;
    const [restored] = await host.request({ action: 'list' });
    if (boundary === 'closed-tab') {
      assert.equal(restored, undefined);
      assert.deepEqual((await taskStore.getSetting('background-runtime-v1')).sources, []);
    } else {
      assert.equal(restored.task, null);
      assert.equal(restored.initialized, false);
      assert.equal(restored.state.canStartBatch, false);
    }
    assert.equal((await taskStore.listTasks()).length, boundary === 'missing-task' ? 0 : 1);
    assert.deepEqual(h.calls, { detect: 0, discover: 0 });
  });

test('worker replacement restores a bound task with previously validated sample regions', async (t) => {
  const h = await boundSource(t);
  h.task.profile.contentSelector = '';
  h.task.profile.samples = h.task.queue.map((chapter) => ({
    ...chapter,
    contentSelector: 'main',
  }));
  h.task.validation.signature = ruleSignature(h.task.profile);
  await taskStore.saveTask(h.task);
  await taskStore.setSetting('background-runtime-v1', {
    sources: [{ tabId: 1, purpose: 'document', initialized: false, taskId: h.task.taskId }],
  });
  const host = h.create();
  await host.ready;
  const [restored] = await host.request({ action: 'list' });
  assert.equal(restored.task?.taskId, h.task.taskId);
  assert.equal(restored.initialized, true, restored.error);
  assert.deepEqual(restored.profile, h.task.profile);
  assert.deepEqual(h.calls, { detect: 0, discover: 0 });
});

test('failed registrations release capacity without touching a live source or its task', async (t) => {
  const h = await boundSource(t),
    host = h.create();
  await host.ready;
  await host.request({ action: 'connect', tabId: 1, purpose: 'document' });
  await host.request({ action: 'initialize', tabId: 1, args: [{ taskId: h.task.taskId }] });
  const before = await taskStore.loadTask(h.task.taskId);
  h.io.tab = async () => {
    throw new Error('No tab with id');
  };
  for (let tabId = 2; tabId <= 10; tabId++)
    await assert.rejects(host.request({ action: 'connect', tabId, purpose: 'document' }), /No tab/);
  const sources = await host.request({ action: 'list' });
  assert.deepEqual(
    sources.map((s) => s.tabId),
    [1],
  );
  assert.equal(h.sessions[0].disposed, false);
  assert.deepEqual(await taskStore.loadTask(h.task.taskId), before);
  assert.deepEqual(
    (await taskStore.getSetting('background-runtime-v1')).sources.map((s) => s.tabId),
    [1],
  );
});

test('eight failed restored connections do not consume capacity or block a live connection', async (t) => {
  const h = await boundSource(t);
  await taskStore.setSetting('background-runtime-v1', {
    sources: Array.from({ length: 8 }, (_, index) => ({
      tabId: index + 1,
      purpose: 'document',
      taskId: h.task.taskId,
    })),
  });
  h.io.tab = async () => {
    throw new Error('No tab with id');
  };
  const before = await taskStore.loadTask(h.task.taskId);
  const host = h.create();
  await host.ready;
  assert.deepEqual(await host.request({ action: 'list' }), []);
  h.io.tab = async () => ({ id: 9, url: h.profile.entry, title: 'Live manual' });
  const live = await host.request({ action: 'connect', tabId: 9, purpose: 'document' });
  assert.equal(live.title, 'Live manual');
  assert.equal(live.connected, true);
  assert.deepEqual(await taskStore.loadTask(h.task.taskId), before);
});

test('eight successful registrations still enforce the limit and allow reconnecting an existing source', async () => {
  const h = setup(),
    host = h.create();
  await host.ready;
  for (let tabId = 1; tabId <= 8; tabId++)
    await host.request({ action: 'connect', tabId, purpose: 'document' });
  await assert.rejects(
    host.request({ action: 'connect', tabId: 9, purpose: 'document' }),
    /8 个来源/,
  );
  assert.equal(
    (await host.request({ action: 'connect', tabId: 1, purpose: 'document' })).connected,
    true,
  );
  assert.equal((await host.request({ action: 'list' })).length, 8);
});

test('closing a previously connected source releases capacity and drops its restore binding without deleting its archive', async (t) => {
  const h = await boundSource(t),
    host = h.create();
  await host.ready;
  for (let tabId = 1; tabId <= 8; tabId++)
    await host.request({ action: 'connect', tabId, purpose: 'document' });
  await host.request({ action: 'initialize', tabId: 1, args: [{ taskId: h.task.taskId }] });
  const before = await taskStore.loadTask(h.task.taskId);
  h.chrome.tabs.onRemoved.emit(1);
  for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sessions[0].closed, true);
  assert.equal(
    (await host.request({ action: 'connect', tabId: 9, purpose: 'document' })).connected,
    true,
  );
  const saved = await taskStore.getSetting('background-runtime-v1');
  assert.deepEqual(
    saved.sources.map((s) => s.tabId),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual((await taskStore.loadTask(h.task.taskId)).pages, before.pages);
  assert.equal((await taskStore.listTasks()).length, 1);
  const restored = h.create();
  await restored.ready;
  assert.equal(
    (await restored.request({ action: 'list' })).some((s) => s.tabId === 1),
    false,
  );
});

test('closing a rotation source releases its persisted binding without changing another rotation', async () => {
  const h = setup(),
    host = h.create();
  await host.ready;
  for (const tabId of [1, 2]) {
    await host.request({ action: 'connect', tabId, purpose: 'rotation' });
    await host.request({
      action: 'rotation:start',
      tabId,
      config: { targets: [{ title: 'Home' }] },
    });
  }
  h.sessions[0].close = async () => {
    h.sessions[0].closed = true;
    h.sessions[0].onChange({}, h.sessions[0]);
  };
  h.chrome.tabs.onRemoved.emit(1);
  for (let n = 0; n < 10; n++) await new Promise((resolve) => setImmediate(resolve));
  const saved = h.saved.get('background-runtime-v1');
  assert.deepEqual(
    saved.sources.map((s) => s.tabId),
    [2],
  );
  assert.deepEqual(
    saved.rotations.map((s) => s.tabId),
    [2],
  );
  assert.equal((await host.request({ action: 'rotation:snapshot', tabId: 2 })).running, true);
});
