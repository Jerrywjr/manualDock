import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(
  new URL('../extension/navigation-discovery.js', import.meta.url),
  'utf8',
).catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
function setup(t, html, url = 'https://device.test/console/#start') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => w.close());
  w.HTMLElement.prototype.getClientRects = function () {
    return [{}];
  };
  let clicks = 0;
  w.document.addEventListener('click', () => clicks++);
  w.eval(source);
  assert.ok(w.SecurityNavigationDiscovery, 'navigation discovery must be available');
  return { w, discover: () => w.SecurityNavigationDiscovery.discover(), clicks: () => clicks };
}
const titles = (result) => Array.from(result.targets, (target) => target.title);

test('discovers actual semantic navigation labels without a device-specific vocabulary or clicks', (t) => {
  const p = setup(
    t,
    '<header><nav aria-label="Primary"><a href="#/overview">Telemetry</a><a href="#/assets">Inventory</a><button role="menuitem">Observability</button></nav></header>',
  );
  const result = p.discover();
  assert.deepEqual(titles(result), ['Telemetry', 'Inventory', 'Observability']);
  assert.equal(result.confidence, 'high');
  assert.equal(result.pathPrefix, '/console/');
  assert.equal(p.clicks(), 0);
  assert.equal(p.w.SecurityNavigationDiscovery.resolveTargets(result).length, 3);
});

test('recognizes generic nonsemantic menu classes and nested visible item labels', (t) => {
  const p = setup(
    t,
    '<header><div class="application-top-menu"><div class="menu-item"><span>资源视图</span></div><div class="menu-item"><span>访问区域</span></div><div class="menu-item"><span>审计中心</span></div></div></header>',
  );
  const result = p.discover();
  assert.deepEqual(titles(result), ['资源视图', '访问区域', '审计中心']);
  assert.equal(result.confidence, 'medium');
  assert.equal(p.w.SecurityNavigationDiscovery.resolveTargets(result).length, 3);
});

test('excludes hidden, disabled, write actions, unsafe URLs, forms, and nested action controls', (t) => {
  const p = setup(
    t,
    `<nav>
    <a id="telemetry" href="#/telemetry">Telemetry</a><button>Inventory</button>
    <button hidden>Hidden</button><button disabled>Disabled</button><button style="display:none">Invisible</button>
    <button>Save</button><button>删除</button><a href="/logout">Session</a>
    <a href="/console/?operation=delete">Apply changes</a><a href="https://other.test/">External</a>
    <form><button>Third</button></form><button form="outside">Attached</button>
    <div role="menuitem">Resources<button>Delete</button></div>
    <a href="#/fourth" target="_blank">New tab</a><a href="javascript:alert(1)">Script</a>
  </nav><form id="outside"></form>`,
  );
  assert.deepEqual(titles(p.discover()), ['Telemetry', 'Inventory']);
  assert.equal(p.clicks(), 0);
});

test('excludes duplicate labels from automated choices while retaining independent unique destinations', (t) => {
  const p = setup(
    t,
    '<nav><a href="#/one">Overview</a><a href="#/two">Overview</a><a href="#/assets">Inventory</a><a href="#/events">Events</a></nav>',
  );
  const result = p.discover();
  assert.deepEqual(titles(result), ['Inventory', 'Events']);
  assert.ok(result.warnings.some((message) => /重名|重复/.test(message)));
  assert.ok(
    result.targets.every((target) => p.w.document.querySelectorAll(target.selector).length === 1),
  );
});

test('prefers top-level primary navigation and does not collect page actions or article tables of contents', (t) => {
  const p = setup(
    t,
    '<header><nav aria-label="Primary"><a href="/dashboard">Dashboard</a><a href="/inventory">Inventory</a></nav></header><main><article><nav><a href="#intro">Introduction</a><a href="#use">Usage</a></nav></article><button>Publish</button></main>',
  );
  const result = p.discover();
  assert.deepEqual(titles(result), ['Dashboard', 'Inventory']);
  assert.equal(result.pathPrefix, '/');
});

test('returns a diagnostic fallback for ambiguous groups or insufficient reliable navigation', (t) => {
  for (const html of [
    '<main><button>Telemetry</button><button>Inventory</button></main>',
    '<nav><button>Inventory</button><button>Save</button></nav>',
    '<nav><a href="#a">Alpha</a><a href="#b">Beta</a></nav><nav><a href="#c">Gamma</a><a href="#d">Delta</a></nav>',
  ]) {
    const p = setup(t, html);
    const result = p.discover();
    assert.deepEqual(titles(result), []);
    assert.equal(result.confidence, 'none');
    assert.ok(result.warnings.some((message) => /点选/.test(message)));
    assert.equal(p.clicks(), 0);
  }
});

test('discovery reads no credentials, scripts, tokens or form values and never runs handlers', (t) => {
  const p = setup(
    t,
    '<nav><button id="alpha" onclick="throw new Error()" data-token="SECRET">Alpha</button><button>Beta</button></nav><form><input type="password" value="PASSWORD"></form>',
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
  const get = p.w.Element.prototype.getAttribute;
  p.w.Element.prototype.getAttribute = function (name) {
    if (['onclick', 'value', 'data-token'].includes(name))
      throw new Error('private attribute read');
    return get.call(this, name);
  };
  const result = p.discover();
  assert.deepEqual(titles(result), ['Alpha', 'Beta']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PASSWORD/);
  assert.equal(p.clicks(), 0);
});

test('revalidation rejects changed labels and unsafe rerendered targets', (t) => {
  const p = setup(
    t,
    '<div class="main-menu"><div class="menu-item" id="one">Alpha</div><div class="menu-item" id="two">Beta</div></div>',
  );
  const result = p.discover();
  p.w.document.getElementById('one').textContent = 'Delete';
  assert.throws(() => p.w.SecurityNavigationDiscovery.resolveTargets(result), /操作|标题/);
  p.w.document.getElementById('one').innerHTML = 'Alpha<button>Delete</button>';
  assert.throws(() => p.w.SecurityNavigationDiscovery.resolveTargets(result), /控件|导航/);
});

test('rejects operation and credential parameters inside hash routes as well as encoded action URLs', (t) => {
  const p = setup(
    t,
    `<nav><a href="#/one">Alpha</a><a href="#/two">Beta</a>
    <a href="#/settings?operation=delete">Gamma</a><a href="#/settings?token=SECRET">Delta</a>
    <a href="/console/sign-out">Session</a><a href="/console/%E5%88%A0%E9%99%A4">Maintenance</a>
  </nav>`,
  );
  assert.deepEqual(titles(p.discover()), ['Alpha', 'Beta']);
  assert.equal(p.clicks(), 0);
});
