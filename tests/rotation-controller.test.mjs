import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const { createRotationController } = await import('../extension/rotation-controller.js').catch(
  (error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  },
);
const scripts = Object.fromEntries(
  await Promise.all(
    ['navigation-discovery.js', 'navigation-rotation.js'].map(async (name) => [
      name,
      await readFile(new URL('../extension/' + name, import.meta.url), 'utf8'),
    ]),
  ),
);
const config = () => ({
  origin: 'https://manual.test',
  pathPrefix: '/admin',
  intervalMs: 60000,
  targets: [
    { selector: '#a', title: 'Policies' },
    { selector: '#b', title: 'Objects' },
  ],
});
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of listeners) fn(...args);
    },
    listeners,
  };
}
function setup(t) {
  let now = 0,
    serial = 0;
  const timers = new Map(),
    pages = new Map(),
    clicks = [],
    held = new Set(),
    changes = [];
  const chrome = {
    runtime: { id: 'manualdock-test', onMessage: event() },
    tabs: {
      onRemoved: event(),
      get: async (id) => {
        const page = pages.get(id);
        if (!page) throw new Error('closed');
        return { id, url: page.w.location.href, status: page.status };
      },
    },
    scripting: {},
  };
  function replace(id, url = 'https://manual.test/admin/home') {
    pages.get(id)?.w.close();
    const w = new JSDOM(
      '<nav><button id="a">Policies</button><button id="b">Objects</button></nav>',
      { url, runScripts: 'outside-only' },
    ).window;
    const page = { w, status: 'complete' };
    pages.set(id, page);
    w.HTMLElement.prototype.getClientRects = () => [{}];
    w.chrome = {
      runtime: {
        sendMessage: async (message) =>
          chrome.runtime.onMessage.emit(message, { id: chrome.runtime.id, tab: { id } }),
      },
    };
    w.document.addEventListener('click', (e) => {
      if (!e.target.closest('#security-navigation-rotation')) clicks.push([id, e.target.id]);
    });
    return page;
  }
  replace(1);
  replace(2);
  chrome.scripting.executeScript = async ({ target, files, func, args = [] }) => {
    const page = pages.get(target.tabId);
    if (!page) throw new Error('closed');
    if (files) {
      for (const name of files) page.w.eval(scripts[name]);
      return [{ result: null }];
    }
    return [{ result: page.w.eval('(' + func.toString() + ')')(...args) }];
  };
  const locks = {
    request: async (name, options, fn) => {
      if (held.has(name)) return fn(null);
      held.add(name);
      try {
        return await fn({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  const clock = {
    setTimeout(fn, delay) {
      timers.set(++serial, { fn, at: now + delay });
      return serial;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const controller = createRotationController({
    chrome,
    locks,
    timers: clock,
    now: () => now,
    onChange: (id, state) => changes.push([id, state]),
  });
  t.after(async () => {
    await controller.dispose();
    for (const { w } of pages.values()) w.close();
  });
  async function advance(ms) {
    const end = now + ms;
    for (let i = 0; i < 200; i++) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {
        now = end;
        return;
      }
      now = next[1].at;
      timers.delete(next[0]);
      await next[1].fn();
    }
    throw new Error('too many timers');
  }
  return { chrome, pages, replace, controller, clicks, held, timers, changes, advance };
}

test('workspace rotation owns independent source locks and one timer per source without a selected UI source', async (t) => {
  const p = setup(t),
    c = p.controller;
  assert.equal((await c.start(1, config())).running, true);
  const deadline = (await c.snapshot(1)).nextAt;
  await c.start(1, config());
  await c.start(2, config());
  assert.equal(p.timers.size, 2);
  assert.equal((await c.snapshot(1)).nextAt, deadline);
  assert.ok(p.held.has('source-tab:1'));
  await p.advance(60000);
  assert.deepEqual(p.clicks, [
    [1, 'a'],
    [2, 'a'],
  ]);
  assert.equal((await c.snapshot(1)).count, 1);
  await c.stop(1);
  assert.equal(p.held.has('source-tab:1'), false);
  await p.advance(60000);
  assert.deepEqual(p.clicks.at(-1), [2, 'b']);
  assert.equal((await c.snapshot(1)).running, false);
});

test('workspace rotation resumes at the next menu after document replacement and waits for complete', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  await p.advance(60000);
  const oldWindow = p.pages.get(1).w;
  oldWindow.dispatchEvent(new oldWindow.Event('pagehide'));
  const page = p.replace(1);
  page.status = 'loading';
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).status, 'waiting');
  assert.equal((await c.snapshot(1)).running, true);
  assert.equal(p.clicks.length, 1);
  page.status = 'complete';
  await p.advance(500);
  assert.deepEqual(p.clicks, [
    [1, 'a'],
    [1, 'b'],
  ]);
  assert.equal((await c.snapshot(1)).count, 2);
  assert.equal(p.timers.size, 1);
});

test('source overlay stop cancels the matching workspace run but forged messages do not', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const page = p.pages.get(1),
    runId = page.w.SecurityNavigationRotation.snapshot().runId;
  p.chrome.runtime.onMessage.emit(
    { type: 'manualdock:rotation-stop', runId },
    { id: 'other-extension', tab: { id: 1 } },
  );
  assert.equal((await c.snapshot(1)).running, true);
  page.w.document.querySelector('[data-security-navigation-stop]').click();
  await Promise.resolve();
  assert.equal((await c.snapshot(1)).running, false);
  assert.equal(p.timers.size, 0);
  await p.advance(120000);
  assert.deepEqual(p.clicks, []);
});

test('scope, missing targets, source closure and workspace disposal stop scheduling and release locks', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  p.replace(1, 'https://manual.test/login');
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).status, 'error');
  assert.equal(p.timers.size, 0);
  assert.match((await c.snapshot(1)).message, /范围/);
  p.replace(1);
  await c.start(1, config());
  p.pages.get(1).w.document.querySelector('#b').remove();
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).running, false);
  assert.deepEqual(p.clicks, []);
  p.replace(1);
  await c.start(1, config());
  await c.start(2, config());
  p.chrome.tabs.onRemoved.emit(1);
  await Promise.resolve();
  assert.equal((await c.snapshot(1)).running, false);
  await c.dispose();
  assert.equal(p.timers.size, 0);
  assert.equal(p.held.size, 0);
  assert.equal(p.chrome.runtime.onMessage.listeners.size, 0);
  assert.equal((await c.start(1, config())).running, false);
});

test('rotation refuses a source lock held by capture and stops after bounded loading wait', async (t) => {
  const p = setup(t),
    c = p.controller;
  p.held.add('source-tab:1');
  assert.equal((await c.start(1, config())).running, false);
  assert.equal(p.timers.size, 0);
  p.held.delete('source-tab:1');
  await c.start(1, config());
  p.pages.get(1).status = 'loading';
  await p.advance(90000);
  assert.equal((await c.snapshot(1)).status, 'error');
  assert.match((await c.snapshot(1)).message, /等待.*超时/);
  assert.equal(p.held.has('source-tab:1'), false);
  assert.deepEqual(p.clicks, []);
});

function gateMethod(p, name) {
  const original = p.chrome.scripting.executeScript;
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  p.chrome.scripting.executeScript = async (options) => {
    if (options.args?.[0] === name) {
      entered();
      await gate;
    }
    return original(options);
  };
  return { ready, release };
}

test('stop during startup waits for the pending prepare and releases the source without scheduling', async (t) => {
  const p = setup(t),
    c = p.controller,
    gate = gateMethod(p, 'prepare');
  const start = c.start(1, config());
  await gate.ready;
  assert.equal((await c.snapshot(1)).status, 'starting');
  const stop = c.stop(1);
  assert.equal((await c.snapshot(1)).running, false);
  assert.ok(p.held.has('source-tab:1'));
  gate.release();
  await Promise.all([start, stop]);
  assert.equal(p.held.has('source-tab:1'), false);
  assert.equal(p.timers.size, 0);
  assert.equal(p.pages.get(1).w.SecurityNavigationRotation.snapshot().running, false);
  await p.advance(120000);
  assert.deepEqual(p.clicks, []);
});

test('dispose during startup cancels pending restart requests and leaves no running state or timer', async (t) => {
  const p = setup(t),
    c = p.controller,
    gate = gateMethod(p, 'prepare');
  const start = c.start(1, config());
  await gate.ready;
  const stop = c.stop(1),
    restartA = c.start(1, config()),
    restartB = c.start(1, config());
  const disposal = c.dispose();
  gate.release();
  const states = await Promise.all([start, stop, restartA, restartB, disposal]);
  assert.equal(states[2].running, false);
  assert.equal(states[3].running, false);
  assert.equal((await c.snapshot(1)).running, false);
  assert.equal(p.held.size, 0);
  assert.equal(p.timers.size, 0);
});

test('concurrent restarts share one run and source lock', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  await c.stop(1);
  const [a, b] = await Promise.all([c.start(1, config()), c.start(1, config())]);
  assert.equal(a.running, true);
  assert.equal(b.running, true);
  assert.equal(p.timers.size, 1);
  assert.equal(p.held.size, 1);
  await p.advance(60000);
  assert.deepEqual(p.clicks, [[1, 'a']]);
});

test('stop during an in-flight step keeps the source lock until its result and schedules no next step', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const gate = gateMethod(p, 'execute'),
    advance = p.advance(60000);
  await gate.ready;
  const stopped = c.stop(1);
  assert.ok(p.held.has('source-tab:1'));
  assert.equal(p.timers.size, 0);
  gate.release();
  await Promise.all([advance, stopped]);
  assert.equal(p.held.size, 0);
  assert.equal(p.timers.size, 0);
  const count = p.clicks.length;
  await p.advance(180000);
  assert.equal(p.clicks.length, count);
});

test('old page runner without managed methods remains intact and requests an explicit refresh', async (t) => {
  const p = setup(t),
    c = p.controller;
  const old = {
    snapshot: () => ({ running: true }),
    stop: () => {
      throw new Error('must not stop another owner');
    },
  };
  p.pages.get(1).w.SecurityNavigationRotation = old;
  const state = await c.start(1, config());
  assert.equal(state.running, false);
  assert.match(state.message, /旧版.*停止.*刷新/);
  assert.equal(p.pages.get(1).w.SecurityNavigationRotation, old);
  assert.equal(p.held.size, 0);
  assert.equal(p.timers.size, 0);
});

test('a click that emits pagehide preserves progress across the new document', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const oldWindow = p.pages.get(1).w;
  oldWindow.document
    .querySelector('#a')
    .addEventListener('click', () => oldWindow.dispatchEvent(new oldWindow.Event('pagehide')));
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).running, true);
  assert.equal((await c.snapshot(1)).count, 1);
  p.replace(1);
  await p.advance(60000);
  assert.deepEqual(p.clicks, [
    [1, 'a'],
    [1, 'b'],
  ]);
  assert.equal((await c.snapshot(1)).count, 2);
});

test('a synchronous out-of-scope route stops immediately after the dispatched click', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const w = p.pages.get(1).w;
  w.document
    .querySelector('#a')
    .addEventListener('click', () => w.history.replaceState({}, '', '/login'));
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).running, false);
  assert.equal((await c.snapshot(1)).status, 'error');
  assert.equal((await c.snapshot(1)).count, 1);
  assert.equal(p.timers.size, 0);
});

test('a lost execute result stops without retrying the possibly dispatched click', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const original = p.chrome.scripting.executeScript;
  p.chrome.scripting.executeScript = async (options) => {
    const result = await original(options);
    if (options.args?.[0] === 'execute') throw new Error('Execution context was destroyed');
    return result;
  };
  await p.advance(60000);
  assert.equal((await c.snapshot(1)).running, false);
  assert.equal((await c.snapshot(1)).status, 'error');
  assert.equal(p.timers.size, 0);
  await p.advance(180000);
  assert.deepEqual(p.clicks, [[1, 'a']]);
});

test('immediate restart waits for delayed stop cleanup before claiming a new page owner', async (t) => {
  const p = setup(t),
    c = p.controller;
  await c.start(1, config());
  const gate = gateMethod(p, 'stopManaged');
  const stopping = c.stop(1);
  await gate.ready;
  const restarting = c.start(1, config());
  await new Promise(setImmediate);
  assert.equal(p.timers.size, 0);
  gate.release();
  const [, restarted] = await Promise.all([stopping, restarting]);
  assert.equal(restarted.running, true);
  assert.equal(p.timers.size, 1);
  assert.equal(p.held.size, 1);
  await p.advance(60000);
  assert.deepEqual(p.clicks, [[1, 'a']]);
});
