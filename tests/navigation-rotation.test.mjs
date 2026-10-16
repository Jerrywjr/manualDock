import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(
  new URL('../extension/navigation-rotation.js', import.meta.url),
  'utf8',
).catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const discoverySource = await readFile(
  new URL('../extension/navigation-discovery.js', import.meta.url),
  'utf8',
);
const menu =
  '<main><nav><a id="policy" href="/admin/#policy"><span>策略</span></a><button id="objects" type="button">对象</button></nav><article><button>保存</button></article></main>';
const config = () => ({
  origin: 'https://manual.test',
  pathPrefix: '/admin',
  targets: [
    { selector: '#policy', title: '策略' },
    { selector: '#objects', title: '对象' },
  ],
});

function setup(t, html = menu, url = 'https://manual.test/admin/#home') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => w.close());
  let now = 0,
    serial = 0;
  const timers = new Map(),
    clicks = [];
  w.Date.now = () => now;
  w.setTimeout = (fn, delay) => {
    timers.set(++serial, { fn, at: now + delay });
    return serial;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.HTMLElement.prototype.getClientRects = function () {
    return [{}];
  };
  w.document.addEventListener('click', (event) => {
    const target = event.target.closest('a,button,[role="menuitem"],[role="tab"]');
    if (!target || target.closest('#security-navigation-rotation')) return;
    event.preventDefault();
    clicks.push(target.id || target.textContent.trim());
  });
  w.eval(discoverySource);
  w.eval(source);
  assert.ok(w.SecurityNavigationRotation, 'script must expose the navigation rotation controller');
  const advance = (ms) => {
    const until = now + ms;
    for (let guard = 0; guard < 100; guard++) {
      const next = [...timers]
        .filter(([, value]) => value.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) {
        now = until;
        return;
      }
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    throw new Error('rotation scheduled too many timers');
  };
  return { w, clicks, timers, advance, controller: w.SecurityNavigationRotation };
}

test('navigation rotation starts idle and waits a full minute before each selected navigation click', (t) => {
  const p = setup(t);
  assert.equal(p.controller.snapshot().running, false);
  assert.equal(p.timers.size, 0);
  assert.equal(p.w.document.getElementById('security-navigation-rotation'), null);
  assert.equal(p.controller.start(config()).running, true);
  p.advance(59999);
  assert.deepEqual(p.clicks, []);
  p.advance(1);
  assert.deepEqual(p.clicks, ['policy']);
  assert.equal(p.controller.snapshot().lastLabel, '策略');
  assert.equal(p.controller.snapshot().nextLabel, '对象');
  p.advance(120000);
  assert.deepEqual(p.clicks, ['policy', 'objects', 'policy']);
  assert.equal(p.controller.snapshot().count, 3);
  assert.match(p.w.document.getElementById('security-navigation-rotation').textContent, /3/);
  p.w.document.querySelector('[data-security-navigation-stop]').click();
  p.advance(180000);
  assert.equal(p.controller.snapshot().running, false);
  assert.equal(p.timers.size, 0);
  assert.deepEqual(p.clicks, ['policy', 'objects', 'policy']);
});

test('navigation rotation repeated start and script reinjection preserve one loop and its first deadline', (t) => {
  const p = setup(t);
  const selected = config();
  p.controller.start(selected);
  p.advance(30000);
  selected.targets[0].selector = 'article button';
  p.controller.start(selected);
  p.w.eval(source);
  p.w.SecurityNavigationRotation.start(selected);
  assert.equal(p.timers.size, 1);
  p.advance(30000);
  assert.deepEqual(p.clicks, ['policy']);
  p.advance(60000);
  assert.deepEqual(p.clicks, ['policy', 'objects']);
});

test('navigation rotation re-resolves selected nodes after rerender and accepts only one visible match', (t) => {
  const p = setup(t, menu + '<nav hidden><a id="policy" href="/admin/">策略</a></nav>');
  assert.equal(p.controller.start(config()).running, true);
  const old = p.w.document.querySelector('main nav');
  old.replaceWith(old.cloneNode(true));
  p.advance(60000);
  assert.deepEqual(p.clicks, ['policy']);
  p.w.document
    .querySelector('main nav')
    .insertAdjacentHTML('beforeend', '<button id="objects">对象</button>');
  p.advance(60000);
  assert.equal(p.controller.snapshot().running, false);
  assert.match(p.controller.snapshot().message, /唯一|多个/);
  assert.deepEqual(p.clicks, ['policy']);
});

test('navigation rotation refuses selectors pointing to content, forms, dangerous controls or changed labels', (t) => {
  const cases = [
    '<main><button id="policy">策略</button><button id="objects">对象</button></main>',
    '<nav><form><button id="policy">策略</button></form><button id="objects">对象</button></nav>',
    '<article><nav><button id="policy">策略</button><button id="objects">对象</button></nav></article>',
    '<nav><button id="policy">保存并下发</button><button id="objects">对象</button></nav>',
    '<nav><button id="policy">其他页面</button><button id="objects">对象</button></nav>',
    '<nav><button id="policy" form="external">策略</button><button id="objects">对象</button></nav><form id="external"></form>',
    '<nav><div contenteditable><button id="policy">策略</button></div><button id="objects">对象</button></nav>',
  ];
  for (const html of cases) {
    const p = setup(t, html);
    assert.equal(p.controller.start(config()).running, false);
    p.advance(180000);
    assert.deepEqual(p.clicks, []);
    assert.ok(p.controller.snapshot().message.length > 0);
  }
  const q = setup(t, '<nav><button id="save">保存</button></nav>');
  assert.equal(
    q.controller.start({ ...config(), targets: [{ selector: '#save', title: '保存' }] }).running,
    false,
  );
});

test('navigation rotation refuses disabled or hidden controls and stops when a target disappears', (t) => {
  for (const attribute of [
    'disabled',
    'aria-disabled="true"',
    'hidden',
    'style="display:none"',
    'inert',
  ]) {
    const p = setup(t, menu.replace('id="objects"', `id="objects" ${attribute}`));
    assert.equal(p.controller.start(config()).running, false);
    assert.deepEqual(p.clicks, []);
  }
  const p = setup(t);
  p.controller.start(config());
  p.w.document.getElementById('policy').remove();
  p.advance(60000);
  assert.equal(p.controller.snapshot().running, false);
  assert.deepEqual(p.clicks, []);
});

test('navigation rotation enforces origin and path boundaries on the page and every navigation link', (t) => {
  for (const destination of [
    'https://other.test/admin/',
    '/administrator/',
    '/admin/logout',
    '/admin/?action=delete',
    'javascript:alert(1)',
    'https://user:pass@manual.test/admin/',
  ]) {
    const p = setup(t, menu.replace('/admin/#policy', destination));
    assert.equal(p.controller.start(config()).running, false);
    p.advance(60000);
    assert.deepEqual(p.clicks, []);
  }
  for (const url of [
    'https://other.test/admin/',
    'https://manual.test/administrator/',
    'https://user:pass@manual.test/admin/',
  ]) {
    const p = setup(t, menu, url);
    assert.equal(p.controller.start(config()).running, false);
  }
  const p = setup(t);
  p.controller.start(config());
  p.w.history.replaceState({}, '', '/admin/#new-view');
  p.advance(60000);
  assert.deepEqual(p.clicks, ['policy']);
  p.w.history.replaceState({}, '', '/login');
  p.advance(60000);
  assert.equal(p.controller.snapshot().running, false);
  assert.deepEqual(p.clicks, ['policy']);
});

test('navigation rotation pagehide and stop during a click never schedule another timer', (t) => {
  const p = setup(t);
  p.controller.start(config());
  p.w.dispatchEvent(new p.w.Event('pagehide'));
  p.advance(180000);
  assert.equal(p.controller.snapshot().running, false);
  assert.equal(p.timers.size, 0);
  assert.equal(p.w.document.getElementById('security-navigation-rotation'), null);
  assert.deepEqual(p.clicks, []);
  const q = setup(t);
  q.w.document.getElementById('policy').addEventListener('click', () => q.controller.stop());
  q.controller.start(config());
  q.advance(180000);
  assert.deepEqual(q.clicks, ['policy']);
  assert.equal(q.controller.snapshot().count, 1);
  assert.equal(q.controller.snapshot().running, false);
  assert.equal(q.timers.size, 0);
});

test('navigation rotation validates data-only configuration and makes timer or click failure visible', (t) => {
  const cases = [
    null,
    {},
    { ...config(), intervalMs: 0 },
    { ...config(), pathPrefix: 'admin' },
    { ...config(), pathPrefix: '/admin/../' },
    { ...config(), targets: [] },
    { ...config(), targets: [{ selector: '???', title: '策略' }] },
    { ...config(), targets: [{ selector: '#policy', title: '策略', script: 'alert(1)' }] },
    { ...config(), intervalMs: () => 60000 },
  ];
  for (const bad of cases) {
    const p = setup(t);
    assert.doesNotThrow(() => p.controller.start(bad));
    assert.equal(p.controller.snapshot().running, false);
    assert.equal(p.timers.size, 0);
  }
  const timed = setup(t);
  timed.w.setTimeout = () => {
    throw new Error('SENSITIVE_TIMER_MESSAGE');
  };
  assert.equal(timed.controller.start(config()).running, false);
  assert.match(timed.controller.snapshot().message, /计时/);
  assert.doesNotMatch(JSON.stringify(timed.controller.snapshot()), /SENSITIVE_TIMER_MESSAGE/);
  const clicked = setup(t);
  clicked.w.document.getElementById('policy').click = () => {
    throw new Error('SENSITIVE_CLICK_MESSAGE');
  };
  clicked.controller.start(config());
  clicked.advance(60000);
  assert.equal(clicked.controller.snapshot().running, false);
  assert.equal(clicked.controller.snapshot().count, 0);
  assert.match(clicked.controller.snapshot().message, /点击/);
  assert.doesNotMatch(JSON.stringify(clicked.controller.snapshot()), /SENSITIVE_CLICK_MESSAGE/);
});

test('navigation rotation reads no credentials or arbitrary data attributes', (t) => {
  const p = setup(
    t,
    menu.replace('id="policy"', 'id="policy" data-token="ATTR_SECRET"') +
      '<form><input type="password" value="PASSWORD_SECRET"></form>',
  );
  Object.defineProperty(p.w.document, 'cookie', {
    get() {
      throw new Error('cookie read');
    },
  });
  Object.defineProperty(p.w, 'localStorage', {
    get() {
      throw new Error('storage read');
    },
  });
  Object.defineProperty(p.w, 'sessionStorage', {
    get() {
      throw new Error('session storage read');
    },
  });
  const original = p.w.Element.prototype.getAttribute;
  p.w.Element.prototype.getAttribute = function (name) {
    if (['data-token', 'value'].includes(name)) throw new Error('forbidden attribute read');
    return original.call(this, name);
  };
  assert.equal(p.controller.start(config()).running, true);
  p.advance(60000);
  assert.deepEqual(p.clicks, ['policy']);
  assert.doesNotMatch(JSON.stringify(p.controller.snapshot()), /ATTR_SECRET|PASSWORD_SECRET/);
});

test('navigation rotation validates a uniquely nested link instead of clicking its unvalidated wrapper', (t) => {
  const unsafe = setup(
    t,
    '<nav><li id="policy"><a href="https://other.test/admin/">策略</a></li><button id="objects">对象</button></nav>',
  );
  assert.equal(unsafe.controller.start(config()).running, false);
  const p = setup(
    t,
    '<nav><li id="policy"><a id="policy-link" href="/admin/#policy">策略</a></li><button id="objects">对象</button></nav>',
  );
  assert.equal(p.controller.start({ ...config(), intervalMs: 2000 }).running, true);
  p.advance(1999);
  assert.deepEqual(p.clicks, []);
  p.advance(1);
  assert.deepEqual(p.clicks, ['policy-link']);
});

test('rotation uses discovered nonsemantic navigation with arbitrary device menu labels', (t) => {
  const p = setup(
    t,
    '<header><div class="appliance-main-menu"><div class="menu-item">Observability</div><div class="menu-item">Inventory</div><div class="menu-item">Trust zones</div></div></header>',
  );
  const detected = p.w.SecurityNavigationDiscovery.discover();
  const clicked = [];
  for (const target of detected.targets)
    p.w.document
      .querySelector(target.selector)
      .addEventListener('click', () => clicked.push(target.title));
  const selected = {
    origin: detected.origin,
    pathPrefix: detected.pathPrefix,
    targets: detected.targets,
    intervalMs: 1000,
  };
  assert.equal(p.controller.start(selected).running, true);
  p.advance(3000);
  assert.deepEqual(clicked, ['Observability', 'Inventory', 'Trust zones']);
  p.w.document.querySelector(detected.targets[0].selector).textContent = 'Apply changes';
  p.advance(1000);
  assert.equal(p.controller.snapshot().running, false);
  assert.equal(p.controller.snapshot().count, 3);
});

test('workspace-managed rotation executes one validated step without a page timer and preserves its owner', (t) => {
  const p = setup(t);
  const c = p.controller;
  assert.equal(c.prepare(config(), { runId: 'run-a', index: 0, count: 0 }).running, true);
  assert.equal(p.timers.size, 0);
  const clicked = c.execute(config(), { runId: 'run-a', index: 0, count: 0 });
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.count, 1);
  assert.deepEqual(p.clicks, ['policy']);
  assert.equal(p.timers.size, 0);
  assert.equal(c.prepare(config(), { runId: 'run-b', index: 0, count: 0 }).running, false);
  assert.equal(c.snapshot().running, true);
  assert.equal(c.execute(config(), { runId: 'run-b', index: 1, count: 1 }).clicked, false);
  assert.deepEqual(p.clicks, ['policy']);
});

test('managed overlay stop notifies its workspace while pagehide does not cancel that workspace', (t) => {
  const p = setup(t);
  const sent = [];
  p.w.chrome = {
    runtime: {
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
  p.controller.prepare(config(), { runId: 'run-a', index: 1, count: 3 });
  p.w.document.querySelector('[data-security-navigation-stop]').click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'manualdock:rotation-stop');
  assert.equal(sent[0].runId, 'run-a');
  assert.equal(
    p.controller.prepare(config(), { runId: 'run-a', index: 1, count: 3 }).running,
    false,
  );
  assert.equal(
    p.controller.execute(config(), { runId: 'run-a', index: 1, count: 3 }).clicked,
    false,
  );
  assert.deepEqual(p.clicks, []);
  p.controller.stopManaged('run-a');
  assert.equal(
    p.controller.prepare(config(), { runId: 'run-b', index: 1, count: 3 }).running,
    true,
  );
  p.w.dispatchEvent(new p.w.Event('pagehide'));
  assert.equal(sent.length, 1);
  assert.equal(p.timers.size, 0);
});

test('managed steps reject stale progress and recheck navigation safety on every click', (t) => {
  const p = setup(t);
  const owner = { runId: 'run-a', index: 0, count: 0 };
  p.controller.prepare(config(), owner);
  assert.equal(p.controller.execute(config(), owner).clicked, true);
  assert.equal(p.controller.execute(config(), owner).clicked, false);
  p.w.document.querySelector('#objects').textContent = 'Apply changes';
  assert.equal(p.controller.execute(config(), { ...owner, index: 1, count: 1 }).clicked, false);
  assert.deepEqual(p.clicks, ['policy']);
});
