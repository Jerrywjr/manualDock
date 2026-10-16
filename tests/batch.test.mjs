import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { SourceSession } from '../extension/session.js';
import { validateProfile } from '../extension/profiles.js';
import { redact } from '../extension/recovery.js';
import { subscribeTasks } from '../extension/task-store.js';
import * as sourceConnector from '../extension/source-connector.js';
import { setupSourceControls } from '../extension/source-controls.js';

const source = await readFile(new URL('../extension/batch.js', import.meta.url), 'utf8');
const html = `<button id="batch-connect">刷新</button><button id="batch-start-all">全部开始</button><button id="batch-pause-all">全部暂停</button><p id="batch-status"></p><div id="batch-list"></div><button id="batch-prev">上一页</button><span id="batch-page"></span><button id="batch-next">下一页</button>`;
const until = async (condition) => {
  for (let n = 0; n < 100 && !condition(); n++) await flush();
  assert.ok(condition(), 'operation must settle before teardown');
};
const flush = async () => {
  for (let count = 0; count < 20; count++) await new Promise((resolve) => setImmediate(resolve));
};
function setup(
  t,
  {
    initialTabId = null,
    queued = [],
    getDefaultPurpose = () => 'document',
    tabURLs = {},
    getTab,
    readSourceTab,
    restoreSources,
  } = {},
) {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const dom = new JSDOM(html, {
    url: 'https://extension.test/panel.html',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  t.after(() => w.close());
  const messages = new Set(),
    removed = new Set(),
    calls = {
      created: [],
      connected: [],
      added: [],
      addedSessions: [],
      captured: [],
      verified: [],
      permissions: 0,
      queries: 0,
      selected: [],
      changed: [],
      errors: [],
      removed: [],
    },
    held = new Set();
  const tabs = new Map(
    Array.from({ length: 10 }, (_, n) => [
      n + 10,
      { id: n + 10, url: tabURLs[n + 10] || `https://manual${n}.test/docs`, title: `Manual ${n}` },
    ]),
  );
  const event = (set) => ({
    addListener: (listener) => set.add(listener),
    removeListener: (listener) => set.delete(listener),
  });
  const locks = {
    request: async (name, _options, action) => {
      if (held.has(name)) return action(null);
      held.add(name);
      try {
        return await action({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  function createSession(options) {
    calls.created.push(options.tabId);
    const tab = tabs.get(options.tabId),
      url = new URL(/^chrome-error:/i.test(tab.url || '') ? tab.pendingUrl : tab.url);
    const profile = validateProfile({
      schemaVersion: 1,
      id: 'p-' + tab.id,
      adapterId: 'generic',
      name: tab.title,
      entry: url.href,
      pathPrefix: '/',
      hashMode: 'none',
      queryKeys: [...url.searchParams.keys()],
      tocSelector: 'nav',
      contentSelector: 'main',
      navigation: 'links',
      samples: [],
    });
    const chapters = ['a', 'b'].map((title) => ({
      key: 'url:' + url.origin + '/' + title,
      url: url.origin + '/' + title,
      title,
    }));
    const session = new SourceSession({
      ...options,
      locks,
      io: {
        tab: async () => {
          if (!tabs.has(tab.id)) throw new Error('原标签页已关闭');
          return readSourceTab ? readSourceTab(tab) : tab;
        },
        detect: async () => ({ profile, warnings: [] }),
        discover: async () => ({ items: chapters, warnings: [] }),
        verifySamples: async () => {
          calls.verified.push(tab.id);
          return { verified: true };
        },
        capture: async (chapter) => {
          calls.captured.push({ tabId: tab.id, key: chapter.key });
          if (calls.captureGate) await calls.captureGate;
          return { status: 'ok', text: 'Body ' + chapter.key, navigationProof: { verified: true } };
        },
        current: async () => ({ status: 'ok', chapter: chapters[0] }),
      },
      clockOptions: { setTimer: () => 1, clearTimer: () => {} },
    });
    const connect = session.connect.bind(session);
    session.connect = async () => {
      calls.connected.push(session.tabId);
      return connect();
    };
    return session;
  }
  w.chrome = {
    runtime: {
      id: 'manualdock',
      onMessage: event(messages),
      sendMessage: async (message) =>
        message.type === 'manualdock:ready' ? { tabIds: queued } : undefined,
    },
    tabs: {
      getCurrent: async () => ({ id: 99 }),
      get: async (id) => (getTab ? getTab(id, tabs) : tabs.get(id)),
      onRemoved: event(removed),
      query: async () => {
        calls.queries++;
        return [];
      },
    },
    permissions: {
      request: async () => {
        calls.permissions++;
        return false;
      },
    },
  };
  Object.assign(w, {
    SourceSession,
    redact,
    subscribeTasks,
    resolveSourcePurpose: sourceConnector.resolveSourcePurpose,
  });
  w.eval(source.replace(/^import .*$/gm, '').replace(/export\s+(?=function)/g, ''));
  w.confirm = () => true;
  const controller = w.setupBatch({
    initialTabId,
    restoreSources,
    getDefaultPurpose,
    createSession,
    onAdded: (session) => {
      calls.added.push(session.tabId);
      calls.addedSessions.push(session);
    },
    onRemoved: (session) => calls.removed.push(session.tabId),
    onSelect: (session) => calls.selected.push(session.tabId),
    onChange: (session) => calls.changed.push(session.tabId),
    onError: (error) => calls.errors.push(error.message),
  });
  t.after(() => controller.dispose());
  const el = (id) => w.document.getElementById(id);
  const receive = async (data, sender = { id: 'manualdock' }) => {
    let response;
    for (const listener of messages)
      listener(data, sender, (value) => {
        response = value;
      });
    await flush();
    return response;
  };
  return { w, calls, tabs, controller, el, receive, removed };
}

test('initial source and action handoff create sessions inside one workspace without extra permissions or frames', async (t) => {
  const p = setup(t, { initialTabId: 10, queued: [10, 11] });
  await flush();
  assert.equal(
    typeof p.controller.getSession,
    'function',
    'the workspace must own direct sessions',
  );
  assert.ok(p.controller.getSession(10));
  assert.ok(p.controller.getSession(11));
  assert.equal(p.w.document.querySelectorAll('iframe').length, 0);
  assert.equal(p.calls.permissions, 0);
  assert.equal(p.calls.queries, 0);
  assert.equal(p.el('batch-list').children.length, 2);
  await p.controller.addSource(10);
  assert.equal(p.el('batch-list').children.length, 2);
});

test('only authenticated extension messages for this workspace add source tabs', async (t) => {
  const p = setup(t);
  await flush();
  await p.receive(
    { type: 'manualdock:add-source', tabId: 10, workspaceTabId: 99 },
    { id: 'other-extension' },
  );
  await p.receive({ type: 'manualdock:add-source', tabId: 10, workspaceTabId: 98 });
  await p.receive({ type: 'manualdock:add-source', tabId: '10', workspaceTabId: 99 });
  assert.equal(p.controller.getSession(10), undefined);
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, true);
  assert.ok(p.controller.getSession(10));
});

test('eight sources stay active while operation rows are paginated', async (t) => {
  const p = setup(t);
  await flush();
  for (let tabId = 10; tabId < 19; tabId++) await p.controller.addSource(tabId);
  assert.equal(p.controller.getSession(18), undefined);
  assert.ok(p.controller.getSession(17));
  assert.equal(p.el('batch-list').children.length, 2);
  assert.match(p.el('batch-page').textContent, /1\s*\/\s*4/);
  p.el('batch-next').click();
  assert.equal(p.el('batch-list').firstElementChild.dataset.tabId, '12');
});

test('all-source controls drive independent sessions and removal preserves saved work', async (t) => {
  const p = setup(t);
  await p.controller.addSource(10);
  await p.controller.addSource(11);
  await p.controller.getSession(10).initialize();
  await p.controller.getSession(11).initialize();
  let release;
  p.calls.captureGate = new Promise((resolve) => {
    release = resolve;
  });
  p.el('batch-start-all').click();
  await flush();
  assert.equal(p.controller.getSession(10).busy, true);
  assert.equal(p.controller.getSession(11).busy, true);
  assert.equal(p.el('batch-list').querySelector('.batch-remove').disabled, true);
  p.el('batch-pause-all').click();
  release();
  await until(() => !p.controller.getSession(10).busy && !p.controller.getSession(11).busy);
  assert.equal(p.controller.getSession(10).getState().canPause, false);
  p.w.confirm = () => false;
  p.el('batch-list').querySelector('.batch-remove').click();
  assert.ok(p.controller.getSession(10));
  let confirmation = '';
  p.w.confirm = (message) => {
    confirmation = message;
    return true;
  };
  p.el('batch-list').querySelector('.batch-remove').click();
  assert.match(confirmation, /保留|不.*删除/);
  assert.equal(p.controller.getSession(10), undefined);
});

test('source selection and current-chapter action use the selected session', async (t) => {
  const p = setup(t);
  await p.controller.addSource(10);
  p.el('batch-list').querySelector('.batch-select').click();
  assert.deepEqual(p.calls.selected, [10]);
  p.el('batch-list').querySelector('.batch-current').click();
  await until(() => !p.controller.getSession(10).busy);
  assert.equal(p.calls.verified.length, 0);
  assert.deepEqual(p.calls.captured, [{ tabId: 10, key: 'url:https://manual0.test/a' }]);
});

test('closing a source stops its session and disposing removes handoff listeners', async (t) => {
  const p = setup(t);
  await p.controller.addSource(10);
  for (const listener of p.removed) listener(10);
  await flush();
  assert.equal(p.controller.getSession(10).getState().canStart, false);
  assert.match(p.el('batch-list').textContent, /已关闭/);
  p.controller.dispose();
  await p.receive({ type: 'manualdock:add-source', tabId: 11, workspaceTabId: 99 });
  assert.equal(p.controller.getSession(11), undefined);
});

test('the workspace answers an authenticated locate request without tab-list permissions', async (t) => {
  const p = setup(t);
  const foreign = await p.receive(
    { type: 'manualdock:locate-workspace' },
    { id: 'foreign-extension' },
  );
  assert.equal(foreign, undefined);
  const located = await p.receive({ type: 'manualdock:locate-workspace' });
  assert.equal(located?.workspace?.id, 99);
  assert.equal(p.calls.permissions, 0);
  assert.equal(p.calls.queries, 0);
});

test('handing in a page registers a connection without scanning or creating saved tasks', async (t) => {
  const p = setup(t);
  await p.controller.addSource(10);
  assert.equal(p.controller.getSession(10).task, null);
  assert.equal(p.controller.getSession(10).initialized, false);
  assert.equal(p.calls.captured.length, 0);
  assert.equal(p.calls.verified.length, 0);
  assert.equal(p.controller.getSession(10).getState().canStart, true);
});

test('document rows and bulk controls exclude rotation sources', async (t) => {
  const p = setup(t);
  const document = await p.controller.addSource(10, { purpose: 'document' });
  const rotation = await p.controller.addSource(11, { purpose: 'rotation' });
  assert.equal(rotation.getState().purpose, 'rotation');
  assert.deepEqual(
    Array.from(p.controller.listSessions(), (session) => session.tabId),
    [10, 11],
  );
  assert.deepEqual(
    Array.from(p.controller.listSessions({ purpose: 'document' }), (session) => session.tabId),
    [10],
  );
  assert.deepEqual(
    Array.from(p.controller.listSessions({ purpose: 'rotation' }), (session) => session.tabId),
    [11],
  );
  assert.equal(p.el('batch-list').children.length, 1);
  assert.equal(p.el('batch-list').firstElementChild.dataset.tabId, '10');
  const driven = [];
  for (const session of [document, rotation]) {
    session.getState = () => ({
      ...SourceSession.prototype.getState.call(session),
      canStart: true,
      canStartBatch: true,
      canPause: true,
    });
    for (const method of ['start', 'pause', 'refresh'])
      session[method] = async () => driven.push([session.tabId, method]);
  }
  p.controller.publish();
  p.el('batch-start-all').click();
  p.el('batch-pause-all').click();
  p.el('batch-connect').click();
  assert.deepEqual(driven, [
    [10, 'start'],
    [10, 'pause'],
    [10, 'refresh'],
  ]);
});

test('readding one tab for another purpose fails without converting or replacing the session', async (t) => {
  const p = setup(t);
  const document = await p.controller.addSource(10);
  await assert.rejects(p.controller.addSource(10, { purpose: 'rotation' }), /用途|独立标签页/);
  assert.equal(p.controller.getSession(10), document);
  assert.equal(document.purpose, 'document');
  assert.equal(await p.controller.addSource(10, { purpose: 'document' }), document);
  const rotation = await p.controller.addSource(11, { purpose: 'rotation' });
  await assert.rejects(p.controller.addSource(11), /用途|独立标签页/);
  assert.equal(p.controller.getSession(11), rotation);
});

test('initial, queued and toolbar sources use the current default purpose without implicit conversion', async (t) => {
  let purpose = 'rotation';
  const p = setup(t, { initialTabId: 10, queued: [11], getDefaultPurpose: () => purpose });
  await p.controller.ready;
  assert.equal(p.controller.getSession(10).purpose, 'rotation');
  assert.equal(p.controller.getSession(11).purpose, 'rotation');
  assert.equal(p.el('batch-list').children.length, 0);
  purpose = 'document';
  const accepted = await p.receive({
    type: 'manualdock:add-source',
    tabId: 12,
    workspaceTabId: 99,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(p.controller.getSession(12).purpose, 'document');
  const rejected = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(p.controller.getSession(10).purpose, 'rotation');
  assert.match(p.calls.errors.at(-1), /独立标签页/);
});

test('external removal disposes a stopped rotation source and refuses a busy source', async (t) => {
  const p = setup(t);
  const rotation = await p.controller.addSource(10, { purpose: 'rotation' });
  rotation.busy = true;
  await assert.rejects(p.controller.removeSource(10), /暂停|停止|运行/);
  assert.equal(p.controller.getSession(10), rotation);
  rotation.busy = false;
  assert.equal(await p.controller.removeSource(10), true);
  assert.equal(rotation.disposed, true);
  assert.equal(p.controller.getSession(10), undefined);
  assert.deepEqual(p.calls.removed, [10]);
  assert.equal(await p.controller.removeSource(10), false);
});

test('a recognition failure shows calibration instead of a ready zero-chapter operation', async (t) => {
  const p = setup(t);
  const session = await p.controller.addSource(10);
  session.io.detect = async () => {
    throw new Error('未找到正文，请校准');
  };
  await session.start();
  const row = p.el('batch-list').firstElementChild;
  assert.match(row.querySelector('.batch-progress').textContent, /待识别|校准/);
  assert.doesNotMatch(row.querySelector('.batch-progress').textContent, /准备就绪|已暂停|0\/0/);
  assert.equal(row.querySelector('.batch-start').disabled, true);
  assert.equal(row.querySelector('.batch-current').disabled, true);
  assert.equal(row.querySelector('.batch-select').textContent, '识别与校准');
});

test('an initialized source with no directory chapters offers calibration and current capture without zero-of-zero ready text', async (t) => {
  const p = setup(t),
    session = await p.controller.addSource(10);
  session.io.discover = async () => ({ items: [], diagnostics: {}, warnings: [] });
  await session.initialize();
  const row = p.el('batch-list').firstElementChild;
  assert.match(row.querySelector('.batch-progress').textContent, /待识别|校准/);
  assert.doesNotMatch(row.querySelector('.batch-progress').textContent, /准备就绪|已暂停|0\/0/);
  assert.equal(row.querySelector('.batch-start').disabled, true);
  assert.equal(row.querySelector('.batch-current').disabled, false);
  assert.equal(row.querySelector('.batch-select').textContent, '识别与校准');
});

test('known manual URLs route initial, ready and toolbar handoffs to documents from the rotation view', async (t) => {
  const p = setup(t, {
    initialTabId: 10,
    queued: [10, 11],
    getDefaultPurpose: () => 'rotation',
    tabURLs: {
      10: 'https://manual.test/adocs.php',
      11: 'https://manual.test/cdocs.php?index=0&dataID=api-menu-item28',
      12: 'https://manual.test/adocs.php?index=1&dataID=api-menu-item29',
    },
  });
  await p.controller.ready;
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 12,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, true, p.calls.errors.join('; '));
  for (const id of [10, 11, 12]) assert.equal(p.controller.getSession(id).purpose, 'document');
  assert.equal(p.calls.captured.length, 0);
  assert.equal(p.calls.verified.length, 0);
  assert.deepEqual(p.calls.created, [10, 11, 12]);
  assert.deepEqual(p.calls.connected, [10, 11, 12]);
});

test('an actual framework management handoff stays rotation when the current view defaults to documents', async (t) => {
  const p = setup(t, { tabURLs: { 10: 'https://manual.test/framework.php#/mod_home/index' } });
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, true);
  assert.equal(p.controller.getSession(10).purpose, 'rotation');
  assert.equal(p.el('batch-list').children.length, 0);
});

test('overlapping URL checks for the same tab connect and notify only once', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const p = setup(t, {
    getTab: async (id, tabs) => {
      await gate;
      return tabs.get(id);
    },
  });
  const first = p.controller.addSource(10);
  const second = p.controller.addSource(10);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(p.calls.created, [10]);
  assert.deepEqual(p.calls.connected, [10]);
  assert.deepEqual(p.calls.added, [10]);
});

test('a workspace disposed during its URL check never creates a late source', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const p = setup(t, {
    getTab: async (id, tabs) => {
      await gate;
      return tabs.get(id);
    },
  });
  const pending = p.controller.addSource(10);
  p.controller.dispose();
  release();
  assert.equal(await pending, undefined);
  assert.deepEqual(p.calls.created, []);
});

test('a source that navigated to a different known purpose cannot convert an active session', async (t) => {
  const p = setup(t, { tabURLs: { 10: 'https://manual.test/adocs.php' } });
  const session = await p.controller.addSource(10);
  session.busy = true;
  p.tabs.get(10).url = 'https://manual.test/framework.php';
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, false);
  assert.equal(p.controller.getSession(10), session);
  assert.equal(session.purpose, 'document');
  assert.equal(session.busy, true);
  assert.match(p.calls.errors.at(-1), /用途|独立标签页/);
});

test('parallel URL checks still enforce the eight-source cap', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const p = setup(t, {
    getTab: async (id, tabs) => {
      await gate;
      return tabs.get(id);
    },
  });
  const pending = Array.from({ length: 9 }, (_, n) => p.controller.addSource(n + 10));
  release();
  const sessions = await Promise.all(pending);
  assert.equal(sessions.filter(Boolean).length, 8);
  assert.equal(p.controller.listSessions().length, 8);
  assert.equal(p.calls.created.length, 8);
  assert.equal(p.calls.connected.length, 8);
});

test('an unreadable source URL creates no session and handoff reports rejection', async (t) => {
  const p = setup(t, {
    getTab: async () => {
      throw new Error('来源已关闭');
    },
  });
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, false);
  assert.equal(p.controller.getSession(10), undefined);
  assert.deepEqual(p.calls.created, []);
  assert.deepEqual(p.calls.captured, []);
  assert.match(p.calls.errors.at(-1), /已关闭/);
});

for (const outcome of ['resolved', 'rejected'])
  test(`removing a pending connection and readding its tab isolates the old ${outcome} connection`, async (t) => {
    let release,
      reads = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const p = setup(t, {
      readSourceTab: async (tab) => {
        if (++reads === 1) {
          await gate;
          if (outcome === 'rejected') throw new Error('old connection failed');
        }
        return tab;
      },
    });
    const oldPending = p.controller.addSource(10);
    // Preserve a rejected result for assertions without leaving an unhandled promise.
    const oldResult = oldPending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await until(() => p.calls.connected.length === 1);
    const oldSession = p.controller.getSession(10);
    assert.equal(await p.controller.removeSource(10), true);
    const newPending = p.controller.addSource(10);
    const newResult = newPending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await flush();
    const replacement = p.controller.getSession(10);
    const connectedBeforeOldSettled = replacement.connected;
    release();
    const [old, fresh] = await Promise.all([oldResult, newResult]);
    assert.notEqual(replacement, oldSession);
    assert.equal(
      connectedBeforeOldSettled,
      true,
      'the replacement must connect independently of the removed session',
    );
    assert.equal(old.value, undefined);
    assert.equal(
      old.error,
      undefined,
      'an obsolete connection cannot report failure into its replacement',
    );
    assert.equal(fresh.value, replacement);
    assert.equal(fresh.error, undefined);
    assert.deepEqual(p.calls.connected, [10, 10]);
    assert.deepEqual(p.calls.addedSessions, [replacement]);
    assert.deepEqual(p.calls.errors, []);
  });

test('closing a source during connection does not announce a connected session', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const p = setup(t, {
    readSourceTab: async (tab) => {
      await gate;
      return tab;
    },
  });
  const pending = p.controller.addSource(10);
  await until(() => p.calls.connected.length === 1);
  for (const listener of p.removed) listener(10);
  release();
  assert.equal(await pending, undefined);
  assert.equal(p.controller.getSession(10).closed, true);
  assert.deepEqual(p.calls.addedSessions, []);
  assert.match(p.el('batch-list').textContent, /已关闭/);
});

test('a current source connection failure still rejects and reports its actual error', async (t) => {
  const p = setup(t, {
    readSourceTab: async () => {
      throw new Error('permission unavailable');
    },
  });
  await assert.rejects(p.controller.addSource(10), /permission unavailable/);
  assert.deepEqual(p.calls.errors, ['permission unavailable']);
  assert.deepEqual(p.calls.addedSessions, []);
  assert.equal(p.controller.getSession(10), undefined);
  assert.deepEqual(p.calls.removed, [10]);
  assert.equal(p.controller.canAddSource(), true);
});

test('a browser-error handoff uses its pending manual URL to preserve document recovery', async (t) => {
  const p = setup(t, { getDefaultPurpose: () => 'rotation' });
  Object.assign(p.tabs.get(10), {
    url: 'chrome-error://chromewebdata/',
    pendingUrl: 'https://manual.test/cdocs.php?index=0&dataID=api-menu-item28',
  });
  const response = await p.receive({
    type: 'manualdock:add-source',
    tabId: 10,
    workspaceTabId: 99,
  });
  assert.equal(response.accepted, true, p.calls.errors.join('; '));
  const session = p.controller.getSession(10);
  assert.equal(session.purpose, 'document');
  assert.equal(session.address, 'https://manual.test/cdocs.php');
  assert.equal(session.connected, true);
  assert.equal(session.task, null, 'registration must not start automatic recovery or capture');
  assert.deepEqual(p.calls.captured, []);
});

for (const [url, pendingUrl, expected] of [
  ['https://manual.test/framework.php', 'https://manual.test/cdocs.php', 'rotation'],
  ['https://manual.test/adocs.php', 'https://manual.test/framework.php', 'document'],
])
  test(`a normal loaded ${expected} URL is never reclassified by pendingUrl`, async (t) => {
    const p = setup(t, {
      getDefaultPurpose: () => (expected === 'document' ? 'rotation' : 'document'),
    });
    Object.assign(p.tabs.get(10), { url, pendingUrl });
    const response = await p.receive({
      type: 'manualdock:add-source',
      tabId: 10,
      workspaceTabId: 99,
    });
    assert.equal(response.accepted, true, p.calls.errors.join('; '));
    assert.equal(p.controller.getSession(10).purpose, expected);
    assert.equal(p.controller.getSession(10).address, url);
  });

test('bulk start skips unrecognized pages and captures only prepared sources', async (t) => {
  const p = setup(t);
  const ready = await p.controller.addSource(10);
  const unknown = await p.controller.addSource(11);
  await ready.initialize();
  let detectionCalls = 0;
  unknown.io.detect = async () => {
    detectionCalls++;
    throw new Error('未识别目录');
  };
  p.controller.publish();
  assert.match(p.el('batch-start-all').textContent, /开始已就绪.*1/);
  p.el('batch-start-all').click();
  await until(() => !ready.busy && !unknown.busy);
  assert.equal(detectionCalls, 0, 'bulk capture must not try to recognize an unprepared page');
  assert.equal(ready.getState().progress.captured, 2);
  assert.equal(unknown.task, null);
  assert.equal(unknown.error, '');
  assert.deepEqual(p.calls.errors, []);
  assert.equal(
    p.el('batch-start-all').disabled,
    true,
    'finished and unprepared pages have no bulk work',
  );
});

test('bulk start does not launch duplicate tasks or interfere with an active owner', async (t) => {
  const p = setup(t);
  const first = await p.controller.addSource(10);
  const second = await p.controller.addSource(11);
  await first.initialize();
  second.adopt(structuredClone(first.task), structuredClone(first.profile));
  let release;
  p.calls.captureGate = new Promise((resolve) => {
    release = resolve;
  });
  p.controller.publish();
  p.el('batch-start-all').click();
  await flush();
  try {
    assert.equal(first.busy, true);
    assert.equal(second.busy, false);
    assert.equal(p.el('batch-start-all').disabled, true);
    assert.deepEqual(p.calls.errors, []);
  } finally {
    release();
  }
  await until(() => !first.busy && !second.busy);
  assert.ok(p.calls.captured.every((item) => item.tabId === 10));
});

test('a rejected background registration leaves no blank source and preserves existing sources', async (t) => {
  let reject = true;
  const p = setup(t, {
    readSourceTab: async (tab) => {
      if (tab.id === 11 && reject) throw new Error('最多同时保留 8 个来源');
      return tab;
    },
  });
  const existing = await p.controller.addSource(10);
  await assert.rejects(p.controller.addSource(11), /8 个来源/);
  assert.equal(p.controller.getSession(11), undefined);
  assert.equal(p.controller.getSession(10), existing);
  assert.equal(existing.disposed, false);
  assert.deepEqual(p.calls.added, [10]);
  assert.equal(p.el('batch-list').children.length, 1);
  reject = false;
  assert.equal((await p.controller.addSource(11)).connected, true);
});

test('one stale restored or queued tab does not hide later live sources', async (t) => {
  const p = setup(t, {
    restoreSources: async () => [
      { tabId: 1, purpose: 'document' },
      { tabId: 10, purpose: 'document' },
    ],
    queued: [2, 11],
  });
  await p.controller.ready;
  assert.deepEqual(p.calls.added, [10, 11]);
  assert.equal(p.calls.errors.length, 2);
  assert.equal(p.controller.listSessions().length, 2);
});

test('the URL form reuses its controlled manual at capacity, then closing a source releases a slot', async (t) => {
  const current = 'https://manual.test/adocs.php?index=7&dataID=api-menu-item58';
  const entry = 'https://manual.test/adocs.php?index=0&dataID=api-menu-item50';
  const p = setup(t, { tabURLs: { 10: current, 19: entry } });
  await p.controller.ready;
  for (let id = 10; id < 18; id++) await p.controller.addSource(id);
  const original = p.controller.getSession(10);
  const d = p.w.document;
  d.body.insertAdjacentHTML(
    'beforeend',
    '<form id="source-connect-form"><input id="source-url"><button id="source-connect"></button></form><select id="source-select"></select><p id="source-connect-status"></p>',
  );
  const selected = [],
    errors = [];
  const browser = p.w.chrome;
  browser.permissions.request = async () => true;
  browser.tabs.query = async () => [...p.tabs.values()];
  browser.tabs.onUpdated = { addListener() {}, removeListener() {} };
  browser.tabs.create = async () => assert.fail('must not create a duplicate or a ninth source');
  for (const tab of p.tabs.values()) tab.status = 'complete';
  const ui = setupSourceControls({
    document: d,
    getController: () => p.controller,
    getSelected: () => original,
    getView: () => 'web',
    connectURL: (raw, options) =>
      sourceConnector.connectSourceURL(raw, { ...options, chrome: browser, timeoutMs: 100 }),
    onSelect: async (session) => selected.push(session),
    onError: (error) => errors.push(error.message),
  });
  t.after(() => ui.dispose());
  d.getElementById('source-url').value = entry;
  d.getElementById('source-connect-form').dispatchEvent(
    new p.w.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.deepEqual(selected, [original]);
  assert.deepEqual(errors, []);
  assert.equal(p.controller.listSessions().length, 8);
  assert.equal(p.tabs.get(10).url, current);
  p.tabs.delete(11);
  for (const listener of p.removed) listener(11);
  await flush();
  assert.equal(p.controller.canAddSource(), true);
  assert.equal((await p.controller.addSource(18)).connected, true);
  assert.equal(p.controller.canAddSource(), false);
});

test('source removal waits for background acknowledgement and retains a rejected source', async (t) => {
  const p = setup(t);
  const session = await p.controller.addSource(10);
  let release;
  session.remove = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = p.controller.removeSource(10);
  assert.equal(p.controller.getSession(10), session);
  assert.equal(session.disposed, false);
  release(true);
  assert.equal(await pending, true);
  assert.equal(p.controller.getSession(10), undefined);
  const other = await p.controller.addSource(11);
  other.remove = async () => {
    throw new Error('来源仍在运行');
  };
  await assert.rejects(p.controller.removeSource(11), /仍在运行/);
  assert.equal(p.controller.getSession(11), other);
  assert.equal(other.disposed, false);
});
