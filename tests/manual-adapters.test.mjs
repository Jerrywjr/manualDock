import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source = await fs
  .readFile(new URL('../extension/manual-adapters.js', import.meta.url), 'utf8')
  .catch(() => '');
const base = {
  schemaVersion: 1,
  id: 'test',
  revision: 1,
  name: 'Guide',
  adapterId: 'generic',
  entry: 'https://example.test/docs/start.html',
  origin: 'https://example.test',
  pathPrefix: '/docs/',
  hashMode: 'none',
  queryKeys: [],
  tocSelector: '#toc',
  contentSelector: 'main',
  navigation: 'links',
  samples: [],
};
function setup(t, html, url = base.entry) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' }),
    w = dom.window;
  t.after(() => w.close());
  w.HTMLElement.prototype.getClientRects = function () {
    return [{}];
  };
  w.eval(source);
  assert.ok(w.SecurityManualAdapters, 'adapter API exists');
  return { w, doc: w.document, api: w.SecurityManualAdapters };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const linkHTML =
  '<nav id="toc"><a href="one.html">One</a><a href="two.html">Two</a></nav><main><h1>One</h1><pre>code</pre><button>Execute API</button></main>';

test('visibility that cannot be determined fails closed and reports the original error', (t) => {
  const { w, api } = setup(t, linkHTML);
  const target = w.document.querySelector('#toc a');
  assert.equal(target.textContent, 'One');
  // Reproduces a getComputedStyle call that rejects, e.g. a torn-down window.
  w.getComputedStyle = () => {
    throw new TypeError('Illegal invocation');
  };
  const result = api.open({
    profile: base,
    chapter: { url: base.entry, title: 'One', locator: { kind: 'generic-toc', path: ['One'] } },
  });
  assert.equal(
    result.clicked,
    false,
    'an unverifiable entry must not be opened as if it were visible',
  );
  assert.match(
    result.reason,
    /Illegal invocation/,
    'the original message must survive, not a generic one',
  );
  assert.equal(result.fault?.name, 'TypeError');
  assert.equal(result.fault?.message, 'Illegal invocation');
  // Plain, serializable data only: nothing here may be a DOM node or function.
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(result.fault))).sort(),
    ['message', 'name', 'stack'],
    'the fault must cross the script boundary without losing fields',
  );
});

test('normalizes document paths and meaningful hash routes without accepting another scope', (t) => {
  const { api } = setup(t, linkHTML);
  const p = { ...base, hashMode: 'route', queryKeys: ['lang'] };
  assert.equal(
    api.normalizeURL('./app?lang=en#/one', p),
    'https://example.test/docs/app?lang=en#/one',
  );
  for (const url of [
    'https://other.test/docs/x',
    'https://u:p@example.test/docs/x',
    '/docs-other/x',
    '/outside',
    'x?token=secret',
    'javascript:alert(1)',
  ])
    assert.equal(api.normalizeURL(url, p), null, url);
  assert.equal(api.normalizeURL('one.html#part', base), 'https://example.test/docs/one.html');
});
test('detect is read-only and proposes actual directory and article containers', (t) => {
  const { api, doc } = setup(t, linkHTML);
  let clicks = 0;
  doc.addEventListener('click', () => clicks++);
  const { profile } = api.detect({ entry: base.entry });
  assert.equal(doc.querySelector(profile.tocSelector).id, 'toc');
  assert.equal(doc.querySelector(profile.contentSelector).tagName, 'MAIN');
  assert.equal(clicks, 0);
});
test('discovers plain-path links only within the configured TOC', async (t) => {
  const { api } = setup(t, linkHTML + '<a href="third.html">Unrelated</a>');
  const r = await api.discover({ profile: base });
  assert.deepEqual(plain(r.items.map((x) => x.url)), [
    'https://example.test/docs/one.html',
    'https://example.test/docs/two.html',
  ]);
  assert.ok(r.items.every((x) => x.key && x.title));
});
test('hash SPA routes remain distinct and URL verification is exact', async (t) => {
  const { api, w } = setup(
    t,
    '<nav id="toc"><a href="#/a">A</a><a href="#/b">B</a></nav><main>A</main>',
    'https://example.test/docs/app#/a',
  );
  const p = { ...base, entry: 'https://example.test/docs/app#/a', hashMode: 'route' };
  const { items } = await api.discover({ profile: p });
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
  assert.equal(api.verify({ profile: p, chapter: items[0] }).verified, true);
  assert.equal(api.verify({ profile: p, chapter: items[1] }).verified, false);
  w.history.replaceState({}, '', '#/b');
  assert.equal(api.verify({ profile: p, chapter: items[1] }).verified, true);
});
test('same-URL chapters keep separate observed paths and require actual selected state', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><ul><li><button aria-selected="true">A</button></li><li><button aria-selected="false">B</button></li></ul></nav><main>A</main>',
  );
  const p = { ...base, navigation: 'click' };
  doc.querySelectorAll('#toc button').forEach((button) =>
    button.addEventListener('click', () => {
      doc
        .querySelectorAll('#toc button')
        .forEach((x) => x.setAttribute('aria-selected', String(x === button)));
      doc.querySelector('main').textContent = button.textContent;
    }),
  );
  const { items } = await api.discover({ profile: p });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, items[1].url);
  assert.notEqual(items[0].key, items[1].key);
  assert.equal(api.verify({ profile: p, chapter: items[1] }).verified, false);
  assert.equal(api.open({ profile: p, chapter: items[1] }).clicked, true);
  assert.equal(doc.querySelector('main').textContent, 'B');
  assert.equal(api.verify({ profile: p, chapter: items[1] }).verified, true);
  doc.querySelectorAll('[aria-selected]').forEach((x) => x.removeAttribute('aria-selected'));
  assert.equal(api.verify({ profile: p, chapter: items[1] }).verified, false);
});
test('ambiguous paths and stale/tree-outside locators never click', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><button>A</button><button>A</button></nav><main><button id="outside">B</button></main>',
  );
  const p = { ...base, navigation: 'click' };
  let clicked = 0;
  doc.addEventListener('click', () => clicked++);
  const r = await api.discover({ profile: p });
  assert.equal(r.items.length, 0);
  assert.ok(r.warnings.length);
  for (const locator of [
    { kind: 'generic-toc', path: ['A'] },
    { kind: 'generic-toc', path: ['B'], selector: '#outside' },
  ])
    assert.equal(
      api.open({ profile: p, chapter: { url: base.entry, title: 'B', locator } }).clicked,
      false,
    );
  assert.equal(clicked, 0);
});
test('expands explicit lazy TOC controls, includes hidden leaves, and never clicks content buttons', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><ul><li><button aria-expanded="false" aria-controls="children">Group</button><ul id="children" hidden></ul></li></ul></nav><main><button aria-expanded="false">Execute</button></main>',
  );
  let expansions = 0,
    unsafe = 0;
  doc.querySelector('main button').onclick = () => unsafe++;
  doc.querySelector('#toc button').onclick = (e) => {
    expansions++;
    e.currentTarget.setAttribute('aria-expanded', 'true');
    doc.querySelector('#children').innerHTML = '<li><a href="leaf.html">Leaf</a></li>';
  };
  const r = await api.discover({ profile: base });
  assert.equal(expansions, 1);
  assert.equal(unsafe, 0);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'Leaf');
});
test('same-origin frame profile discovers its actual directory and refuses ambiguous frames', async (t) => {
  const { api, doc } = setup(t, '<iframe id="manual"></iframe>');
  const frame = doc.querySelector('iframe');
  frame.contentDocument.body.innerHTML = linkHTML;
  const p = { ...base, frameSelector: '#manual' };
  const r = await api.discover({ profile: p });
  assert.equal(r.items.length, 2);
  doc.body.append(frame.cloneNode());
  const bad = await api.discover({ profile: p });
  assert.equal(bad.items.length, 0);
  assert.ok(bad.warnings.length);
});
test('sample picker consumes the click and only selects an actual TOC chapter', async (t) => {
  const { api, doc, w } = setup(t, linkHTML);
  let actions = 0;
  doc.querySelector('#toc a').onclick = () => actions++;
  const picking = api.pick({ kind: 'sample', profile: base });
  doc
    .querySelector('main button')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  doc
    .querySelector('#toc a')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const picked = await picking;
  assert.equal(picked.title, 'One');
  assert.equal(picked.url, 'https://example.test/docs/one.html');
  assert.equal(actions, 0);
  assert.equal(picked.selector.length > 0, true);
});
test('content and rotation picker cancel with Escape and clean up interception', async (t) => {
  const { api, doc, w } = setup(t, linkHTML);
  for (const kind of ['content', 'rotation']) {
    const picking = api.pick({ kind, profile: base });
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await assert.rejects(picking, /取消|cancel/i);
  }
  let actions = 0;
  doc.querySelector('main button').onclick = () => actions++;
  doc.querySelector('main button').click();
  assert.equal(actions, 1);
});
test('Sangfor adapter delegates actual Ext path open and verify without inventing URLs', async (t) => {
  const { api, w } = setup(
    t,
    '<ul class="x-tree-root-ct"></ul><main>Body</main>',
    'https://example.test/adocs.php',
  );
  const locator = { kind: 'sangfor-ext-tree', path: ['1 Group', '1.1 Leaf'] };
  let opened;
  w.SangforTree = {
    directoryRoots: () => [...w.document.querySelectorAll('ul.x-tree-root-ct')],
    scan: () => ({
      items: [{ url: 'https://example.test/adocs.php', title: '1.1 Leaf', locator }],
      warnings: [],
      diagnostics: { leaves: 1 },
    }),
    open: (x) => ((opened = x), { clicked: true }),
    verify: () => ({ verified: true, kind: 'sangfor-ext-tree', path: locator.path }),
  };
  const p = {
    ...base,
    adapterId: 'sangfor',
    entry: 'https://example.test/adocs.php',
    pathPrefix: '/adocs.php',
    tocSelector: '.x-tree-root-ct',
  };
  const { items } = await api.discover({ profile: p });
  assert.equal(items.length, 1);
  assert.ok(items[0].key);
  assert.equal(api.open({ profile: p, chapter: items[0] }).clicked, true);
  assert.deepEqual(plain(opened.locator.path), locator.path);
  assert.equal(api.verify({ profile: p, chapter: items[0] }).verified, true);
});

test('content-script normalization is equivalent to the shared profiles module', async (t) => {
  const { normalizeDocumentURL } = await import('../extension/profiles.js');
  const { api } = setup(t, linkHTML);
  const urls = [
    'one.html',
    '#part',
    '#/chapter?lang=en',
    '../outside',
    '/docs',
    '/docs/a',
    '/docs-other/a',
    '/docs/save.php',
    '/docs/logout',
    '/docs/a?lang=en',
    '/docs/a?lang=en&lang=zh',
    '/docs/a?token=s',
    'https://u@example.test/docs/a',
    '//other.test/docs/a',
    '/docs/a#/?token=s',
    '/docs/a?index=01&dataID=A',
    'javascript:void(0)',
    'x\\y',
  ];
  for (const hashMode of ['none', 'anchor', 'route'])
    for (const pathPrefix of ['/docs/', '/docs', '/'])
      for (const raw of urls) {
        const profile = { ...base, hashMode, pathPrefix, queryKeys: ['lang', 'index', 'dataID'] };
        assert.equal(
          api.normalizeURL(raw, profile),
          normalizeDocumentURL(raw, profile),
          JSON.stringify({ hashMode, pathPrefix, raw }),
        );
      }
});
test('route authentication query keys are rejected by both normalization copies and directory discovery', async (t) => {
  const { normalizeDocumentURL } = await import('../extension/profiles.js');
  const keys = [
    'access_token',
    'sessionid',
    'csrf',
    'auth_token',
    'ticket',
    'jwt',
    'api_key',
    '%61ccess%5ftoken',
    '%73essionid',
    '%63srf',
  ];
  const blocked = keys.map((key) => '#/chapter?lang=en&' + key + '=EXAMPLE');
  const { api } = setup(
    t,
    '<nav id="toc"><a href="#/chapter?lang=en&page=02">Safe</a>' +
      blocked.map((url, index) => `<a href="${url}">Blocked ${index}</a>`).join('') +
      '</nav><main>Body</main>',
  );
  const p = { ...base, hashMode: 'route' };
  for (const raw of blocked) {
    assert.equal(api.normalizeURL(raw, p), null, raw);
    assert.equal(api.normalizeURL(raw, p), normalizeDocumentURL(raw, p), raw);
  }
  const result = await api.discover({ profile: p });
  assert.deepEqual(plain(result.items.map((item) => item.url)), [
    'https://example.test/docs/start.html#/chapter?lang=en&page=02',
  ]);
});
test('generic discovery preserves nested paths without an href', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><ul><li><span>Group</span><ul><li><span>Leaf</span></li></ul></li></ul></nav><main>Body</main>',
  );
  const p = { ...base, navigation: 'click' };
  const { items } = await api.discover({ profile: p });
  assert.equal(items.length, 1);
  assert.deepEqual(plain(items[0].locator.path), ['Group', 'Leaf']);
  let clicked = false;
  doc.querySelector('#toc li li span').onclick = () => (clicked = true);
  assert.equal(api.open({ profile: p, chapter: items[0] }).clicked, true);
  assert.equal(clicked, true, 'click the visible label, not its li ancestor');
});
test('directory root wrapped in main remains supported while whole-body rules are refused', async (t) => {
  const { api } = setup(
    t,
    '<main>' + linkHTML.replace('<main>', '<section>').replace('</main>', '</section>') + '</main>',
  );
  assert.equal((await api.discover({ profile: base })).items.length, 2);
  const rejected = await api.discover({ profile: { ...base, tocSelector: 'body' } });
  assert.equal(rejected.items.length, 0);
  assert.ok(rejected.warnings.length);
});
test('toc and content picker return actual distinct regions without navigation', async (t) => {
  const { api, doc, w } = setup(t, linkHTML);
  const toc = api.pick({ kind: 'toc', profile: base });
  doc
    .querySelector('#toc a')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector((await toc).selector).id, 'toc');
  const body = api.pick({ kind: 'content', profile: base });
  doc
    .querySelector('main h1')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector((await body).selector).tagName, 'MAIN');
});
test('rotation picker rejects body controls and picks a literal navigation label without clicking', async (t) => {
  const { api, doc, w } = setup(
    t,
    '<nav><button id="nav-target">Policies</button></nav><article><nav><button id="api-example">Policies</button></nav></article><button id="body-target">Policies</button>',
  );
  let clicks = 0;
  doc.querySelectorAll('button').forEach((button) => (button.onclick = () => clicks++));
  const picking = api.pick({ kind: 'rotation', profile: base });
  for (const id of ['body-target', 'api-example', 'nav-target'])
    doc
      .getElementById(id)
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const result = await picking;
  assert.equal(result.selector, '#nav-target');
  assert.equal(result.title, 'Policies');
  assert.equal(clicks, 0);
});
test('same-origin frame sample picker returns frame identity', async (t) => {
  const { api, doc } = setup(t, '<iframe id="manual"></iframe>');
  const frame = doc.querySelector('iframe');
  frame.contentDocument.body.innerHTML = linkHTML;
  const p = { ...base, frameSelector: '#manual' };
  const picking = api.pick({ kind: 'sample', profile: p });
  frame.contentDocument
    .querySelector('#toc a')
    .dispatchEvent(
      new frame.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  const value = await picking;
  assert.equal(value.frameSelector, '#manual');
  assert.equal(value.title, 'One');
});
test('built-in tree adapter discovers a synthetic 600-leaf directory through the real reader', async (t) => {
  const fixture =
    '<ul class="x-tree-root-ct">' +
    Array.from(
      { length: 600 },
      (_, i) =>
        `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item${i}"><span>Chapter ${i}</span></div><ul class="x-tree-node-ct"></ul></li>`,
    ).join('') +
    '</ul>';
  const tree = await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8');
  const { api, w } = setup(t, fixture, 'https://example.test/adocs.php');
  w.eval(tree);
  const p = {
    ...base,
    adapterId: 'sangfor',
    entry: 'https://example.test/adocs.php',
    pathPrefix: '/adocs.php',
    tocSelector: '.x-tree-root-ct',
    contentSelector: '',
  };
  const result = await api.discover({ profile: p });
  assert.equal(result.items.length, 600);
  assert.ok(result.items.every((x) => x.locator.kind === 'sangfor-ext-tree'));
});
test('chapters above 5000 are not silently treated as a complete directory', async (t) => {
  const { api } = setup(
    t,
    '<nav id="toc">' +
      Array.from({ length: 5001 }, (_, i) => `<a href="${i}.html">Chapter ${i}</a>`).join('') +
      '</nav><main>Body</main>',
  );
  const result = await api.discover({ profile: base });
  assert.equal(result.items.length, 5000);
  assert.equal(result.diagnostics.truncated, true);
  assert.ok(result.warnings.some((x) => /上限|完整/.test(x)));
});

test('detect never returns a draft profile containing URL credentials or tokens', (t) => {
  const { api } = setup(t, linkHTML, base.entry + '?token=private');
  for (const suffix of [
    '?token=private',
    '#/chapter?access_token=EXAMPLE',
    '#/chapter?%73essionid=EXAMPLE',
    '#/chapter?csrf=EXAMPLE',
  ])
    assert.throws(() => api.detect({ entry: base.entry + suffix }), /认证|允许/, suffix);
});

test('rotation picker supports observed Sangfor menu-item labels without a role attribute', async (t) => {
  const { api, doc, w } = setup(
    t,
    '<div class="yama-layout-header__content__menu"><div class="ix-menu-item" id="policies"><span>策略</span></div></div>',
  );
  const picking = api.pick({ kind: 'rotation', profile: base });
  doc
    .querySelector('#policies span')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  // Escape makes an unsupported target fail immediately instead of waiting for picker timeout.
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal((await picking).selector, '#policies');
});

test('known Sangfor directory wins over unrelated header links during detection', (t) => {
  const { api, doc } = setup(
    t,
    '<nav><a href="help.html">Help</a><a href="about.html">About</a></nav><ul class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><span>Chapter</span></div><ul class="x-tree-node-ct"></ul></li></ul><main>Body</main>',
    'https://example.test/adocs.php',
  );
  const { profile } = api.detect({ entry: 'https://example.test/adocs.php' });
  assert.equal(profile.adapterId, 'sangfor');
  assert.ok(doc.querySelector(profile.tocSelector).matches('.x-tree-root-ct'));
});

test('TOC picker climbs from a custom chapter button to the bounded multi-item region', async (t) => {
  const { api, doc, w } = setup(
    t,
    '<div id="custom-toc"><div id="alpha" role="tab">Alpha</div><div role="tab">Beta</div></div><section id="body">Body</section>',
  );
  let clicks = 0;
  doc.querySelector('#alpha').onclick = () => clicks++;
  const picking = api.pick({ kind: 'toc', profile: base });
  doc
    .querySelector('#alpha')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const result = await picking;
  assert.equal(result.selector, '#custom-toc');
  assert.equal(clicks, 0);
});

test('picker suppresses release and touch events on API buttons and restores every listener after cancel', async (t) => {
  const { api, doc, w } = setup(t, linkHTML);
  const button = doc.querySelector('main button');
  let actions = 0;
  const events = [
    'pointerup',
    'mouseup',
    'touchstart',
    'touchend',
    'touchcancel',
    'keydown',
    'keyup',
    'auxclick',
    'dblclick',
    'contextmenu',
  ];
  for (const type of events) button.addEventListener(type, () => actions++);
  const picking = api.pick({ kind: 'sample', profile: base });
  for (const type of events)
    button.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  assert.equal(
    actions,
    0,
    'picker must stop page release/touch handlers as well as click handlers',
  );
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await assert.rejects(picking, /取消/);
  for (const type of events)
    button.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  assert.equal(
    actions,
    events.length,
    'all picker interception must be removed after cancellation',
  );
});

test('lazy branch waits for delayed children after aria-expanded is already true', async (t) => {
  const { api, doc, w } = setup(
    t,
    '<nav id="toc"><ul><li><button aria-expanded="false" aria-controls="children">Group</button><ul id="children" hidden></ul></li></ul></nav><main><button>Execute</button></main>',
  );
  let expansions = 0,
    unsafe = 0;
  doc.querySelector('main button').onclick = () => unsafe++;
  doc.querySelector('#toc button').onclick = (e) => {
    expansions++;
    e.currentTarget.setAttribute('aria-expanded', 'true');
    w.setTimeout(() => {
      doc.querySelector('#children').innerHTML = '<li><a href="delayed.html">Delayed leaf</a></li>';
      doc.querySelector('#children').hidden = false;
    }, 1800);
  };
  const started = Date.now(),
    result = await api.discover({ profile: base });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Delayed leaf');
  assert.equal(result.diagnostics.pendingBranches, 0);
  assert.equal(expansions, 1);
  assert.equal(unsafe, 0);
  assert.ok(
    Date.now() - started >= 1800,
    'the collapsed-to-expanded attribute is not loading completion',
  );
});

test('lazy branch timeout reports expanded but unloaded branches as incomplete', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><ul><li><button aria-expanded="false" aria-controls="children">Group</button><ul id="children"></ul></li></ul></nav><main>Body</main>',
  );
  let expansions = 0;
  doc.querySelector('#toc button').onclick = (e) => {
    expansions++;
    e.currentTarget.setAttribute('aria-expanded', 'true');
  };
  const started = Date.now(),
    result = await api.discover({ profile: base });
  assert.equal(result.items.length, 0);
  assert.equal(expansions, 1);
  assert.equal(result.diagnostics.pendingBranches, 1);
  assert.equal(result.diagnostics.unloadedBranches, 1);
  assert.ok(result.warnings.some((x) => /未加载|不完整/.test(x)));
  assert.ok(Date.now() - started >= 5000);
  assert.ok(Date.now() - started < 9000, 'loading wait is bounded');
});

for (const pathname of ['/adocs.php', '/cdocs.php'])
  test('Ext tree detection, discovery and manual sample picking work on ' + pathname, async (t) => {
    const url = 'https://example.test' + pathname + '?index=1&dataID=api-menu-item31';
    const fixture =
      '<ul class="x-tree-root-ct">' +
      ['31', '32']
        .map(
          (id, i) =>
            `<li class="x-tree-node"><div class="x-tree-node-el" ext:tree-node-id="api-menu-item${id}"><span>Chapter ${i + 1}</span></div><ul class="x-tree-node-ct"></ul></li>`,
        )
        .join('') +
      '</ul><div id="articleContent">Command help</div>';
    const { api, w, doc } = setup(t, fixture, url);
    w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
    const { profile } = api.detect({ entry: url });
    assert.equal(profile.adapterId, 'sangfor');
    assert.equal(profile.pathPrefix, pathname);
    const result = await api.discover({ profile });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].locator.nodeId, 'api-menu-item31');
    let clicks = 0;
    doc.addEventListener('click', () => clicks++);
    const picking = api.pick({ kind: 'sample', profile });
    doc
      .querySelector('.x-tree-node-el span')
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const sample = await picking;
    assert.equal(sample.title, 'Chapter 1');
    assert.equal(sample.locator.nodeId, 'api-menu-item31');
    assert.equal(clicks, 0);
    assert.equal(
      w.SangforTree.scan({
        entry: 'https://example.test' + (pathname === '/adocs.php' ? '/cdocs.php' : '/adocs.php'),
      }).items.length,
      0,
      'API and CLI scopes must not be mixed',
    );
  });
test('manual TOC calibration from a nested CLI label selects the full supported tree', async (t) => {
  const url = 'https://example.test/cdocs.php?index=1&dataID=api-menu-item31';
  const { api, w, doc } = setup(
    t,
    '<ul id="tocRoot" class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><span>Commands</span></div><ul id="nested" class="x-tree-node-ct"><li class="x-tree-node"><div class="x-tree-node-el" ext:tree-node-id="api-menu-item31"><span id="leaf">show interface</span></div><ul class="x-tree-node-ct"></ul></li></ul></li></ul><main>Command help</main>',
    url,
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  const picking = api.pick({ kind: 'toc', profile });
  doc
    .querySelector('#leaf')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const selected = await picking;
  assert.equal(
    selected.selector,
    '#tocRoot',
    'calibration must retain the parents needed to resolve full chapter paths',
  );
  const calibrated = { ...profile, tocSelector: selected.selector };
  const sampling = api.pick({ kind: 'sample', profile: calibrated });
  doc
    .querySelector('#leaf')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const sample = await sampling;
  assert.deepEqual(plain(sample.locator.path), ['Commands', 'show interface']);
});
test('chapter verification stays cheaper than one directory scan on a large CLI tree', async (t) => {
  const url = 'https://example.test/cdocs.php?index=1&dataID=api-menu-item31';
  let fixture =
    '<ul class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><span>Commands</span></div><ul class="x-tree-node-ct">';
  for (let i = 0; i < 1200; i++)
    fixture += `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf${i === 0 ? ' x-tree-selected' : ''}" ext:tree-node-id="api-menu-item${31 + i}"><span>Chapter ${i + 1}</span></div><ul class="x-tree-node-ct"></ul></li>`;
  fixture += '</ul></li></ul><div id="articleContent">Command help</div>';
  const { api, w } = setup(t, fixture, url);
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  assert.equal(profile.adapterId, 'sangfor');
  const scanStart = performance.now();
  const items = w.SangforTree.scan({ entry: url }).items;
  const scanMs = performance.now() - scanStart;
  assert.equal(items.length, 1200);
  assert.equal(
    api.verify({ profile, chapter: items[0] }).verified,
    true,
    'the selected chapter must be proven',
  );
  assert.equal(
    api.verify({ profile, chapter: items[1] }).verified,
    false,
    'an unselected chapter must never be reported as proven',
  );
  const started = performance.now();
  for (let i = 0; i < 30; i++) api.verify({ profile, chapter: items[0] });
  const per = (performance.now() - started) / 30;
  assert.ok(
    per < scanMs,
    `verifying (${per.toFixed(1)}ms each) must stay cheaper than one full directory scan (${scanMs.toFixed(1)}ms)`,
  );
});
test('verification never trusts an ambiguous node id and reports the unselected chapter', async (t) => {
  const url = 'https://example.test/cdocs.php?index=1&dataID=api-menu-item31';
  const row =
    '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item31"><span>Chapter 1</span></div><ul class="x-tree-node-ct"></ul></li>';
  // Two rows share the observed id, so nothing may be proven without a full scan.
  const { api, w } = setup(
    t,
    `<ul class="x-tree-root-ct">${row}${row}</ul><div id="articleContent">Command help</div>`,
    url,
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  const result = api.verify({
    profile,
    chapter: {
      url,
      title: 'Chapter 1',
      locator: { kind: 'sangfor-ext-tree', path: ['Chapter 1'], nodeId: 'api-menu-item31' },
    },
  });
  assert.equal(result.verified, false);
  assert.ok(
    result.reason && result.reason !== 'selected-path-matches',
    `ambiguity must not be answered from the short path: ${result.reason}`,
  );
});
test('generic verification proves the recorded path and stays local to the directory', (t) => {
  const { api, doc } = setup(
    t,
    '<ul id="toc"><li><a id="one" href="#" class="selected">One</a></li><li><a id="two" href="#">Two</a></li></ul><main><h1>One</h1></main>',
  );
  const profile = {
    ...base,
    entry: 'https://example.test/docs/start.html',
    pathPrefix: '/docs/',
    tocSelector: '#toc',
    contentSelector: 'main',
    navigation: 'click',
  };
  assert.equal(
    api.verify({
      profile,
      chapter: {
        url: profile.entry,
        title: 'One',
        locator: { kind: 'generic-toc', path: ['One'], nodeId: 'one' },
      },
    }).verified,
    true,
  );
  assert.equal(
    api.verify({
      profile,
      chapter: {
        url: profile.entry,
        title: 'Two',
        locator: { kind: 'generic-toc', path: ['Two'], nodeId: 'two' },
      },
    }).verified,
    false,
  );
  // A node id that exists but belongs to another path must not be accepted.
  assert.equal(
    api.verify({
      profile,
      chapter: {
        url: profile.entry,
        title: 'One',
        locator: { kind: 'generic-toc', path: ['Two'], nodeId: 'one' },
      },
    }).verified,
    false,
  );
  doc.querySelector('#two').classList.add('selected');
  doc.querySelector('#one').classList.remove('selected');
  assert.equal(
    api.verify({
      profile,
      chapter: {
        url: profile.entry,
        title: 'Two',
        locator: { kind: 'generic-toc', path: ['Two'], nodeId: 'two' },
      },
    }).verified,
    true,
  );
  assert.equal(
    api.verify({
      profile,
      chapter: {
        url: profile.entry,
        title: 'One',
        locator: { kind: 'generic-toc', path: ['One'], nodeId: 'one' },
      },
    }).verified,
    false,
  );
});

test('quick discovery records loaded chapters without opening lazy branches', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><a href="loaded.html">Loaded</a><ul><li><button aria-expanded="false" aria-controls="lazy">Later</button><ul id="lazy"></ul></li></ul></nav><main>Body</main>',
  );
  let clicks = 0;
  doc.querySelector('#toc button').onclick = () => {
    clicks++;
    doc.querySelector('#lazy').innerHTML = '<li><a href="new.html">New</a></li>';
  };
  const result = await api.discover({ profile: base, expand: false });
  assert.equal(clicks, 0);
  assert.deepEqual(plain(result.items.map((c) => c.title)), ['Loaded']);
  assert.equal(result.diagnostics.pendingBranches, 1);
  assert.ok(result.warnings.some((x) => /不完整/.test(x)));
});

test('Ext verification rejects a stale ancestor path even when node id and leaf title still match', async (t) => {
  const url = 'https://example.test/cdocs.php?index=1&dataID=api-menu-item31';
  const { api, w, doc } = setup(
    t,
    '<ul class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><span id="group">Original</span></div><ul class="x-tree-node-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-selected" ext:tree-node-id="api-menu-item31"><span>show interface</span></div><ul class="x-tree-node-ct"></ul></li></ul></li></ul><main>Body</main>',
    url,
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  const { items } = await api.discover({ profile, expand: false });
  assert.equal(api.verify({ profile, chapter: items[0] }).verified, true);
  doc.querySelector('#group').textContent = 'Changed';
  assert.equal(api.verify({ profile, chapter: items[0] }).verified, false);
  assert.equal(
    w.SangforTree.verify({
      entry: 'https://example.test/adocs.php',
      locator: { ...items[0].locator, path: ['Changed', 'show interface'] },
    }).verified,
    false,
    'same node id must not cross API/CLI scope',
  );
});

test('current chapter discovery uses the observed selected entry and rejects ambiguous selection', async (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="toc"><button id="one" aria-selected="true">One</button><button id="two">Two</button></nav><main>Body</main>',
  );
  const profile = { ...base, navigation: 'click' };
  assert.equal(typeof api.current, 'function');
  assert.equal(api.current({ profile }).chapter.title, 'One');
  doc.querySelector('#two').setAttribute('aria-selected', 'true');
  assert.equal(api.current({ profile }).status, 'error');
  doc.querySelector('#one').setAttribute('aria-selected', 'false');
  assert.equal(api.current({ profile }).chapter.title, 'Two');
});
test('current linked chapter is matched to its document URL', (t) => {
  const { api } = setup(
    t,
    '<nav id="toc"><a href="start.html">Current</a><a href="other.html">Other</a></nav><main>Body</main>',
  );
  assert.equal(typeof api.current, 'function');
  assert.equal(api.current({ profile: base }).chapter.title, 'Current');
});
test('Ext current chapter reads the unique selected leaf and refuses ambiguous selected leaves', async (t) => {
  const url = 'https://example.test/cdocs.php';
  const row = (id, title, selected) =>
    `<li class="x-tree-node"><div class="x-tree-node-el ${selected ? 'x-tree-selected' : ''}" ext:tree-node-id="api-menu-item${id}"><span>${title}</span></div><ul class="x-tree-node-ct"></ul></li>`;
  const { api, w, doc } = setup(
    t,
    '<ul class="x-tree-root-ct">' +
      row(31, 'One', true) +
      row(32, 'Two', false) +
      '</ul><main>Body</main>',
    url,
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  assert.equal(typeof api.current, 'function');
  assert.equal(api.current({ profile }).chapter.title, 'One');
  doc.querySelectorAll('.x-tree-node-el')[1].classList.add('x-tree-selected');
  assert.equal(api.current({ profile }).status, 'error');
});

test('reinjection replaces a stale adapter so recognition uses the newly installed code', (t) => {
  const { w, doc } = setup(t, linkHTML);
  let oldCalls = 0;
  w.SecurityManualAdapters = Object.freeze({
    detect: () => {
      oldCalls++;
      return {};
    },
  });
  w.eval(source);
  const { profile } = w.SecurityManualAdapters.detect({ entry: base.entry });
  assert.equal(oldCalls, 0, 'an old injected adapter must not survive reinstall');
  assert.equal(doc.querySelector(profile.tocSelector).id, 'toc');
});

test('reinjection cancels an active picker and removes its page event interception', async (t) => {
  const { w, doc, api } = setup(t, linkHTML);
  const picking = api.pick({ kind: 'content', profile: base });
  const rejected = assert.rejects(picking, /取消/);
  assert.ok(doc.querySelector('[data-security-picker]'));
  w.eval(source);
  assert.equal(doc.querySelector('[data-security-picker]'), null);
  await rejected;
  let clicks = 0;
  doc.querySelector('main button').onclick = () => clicks++;
  doc.querySelector('main button').click();
  assert.equal(clicks, 1);
});

test('detection excludes a page wrapper containing the TOC from article candidates', (t) => {
  const url = 'https://example.test/cdocs.php?index=0&dataID=api-menu-item28';
  const { api, doc } = setup(
    t,
    '<div id="content"><ul id="tree" class="x-tree-root-ct"><li><span>Commands</span></li></ul><div id="articleContent">Current CLI help</div></div>',
    url,
  );
  const { profile, warnings } = api.detect({ entry: url });
  assert.equal(profile.entry, url, 'the observed zero-based URL is accepted unchanged');
  assert.equal(profile.adapterId, 'sangfor');
  assert.deepEqual(
    [...doc.querySelectorAll(profile.tocSelector)].map((el) => el.id),
    ['tree'],
  );
  assert.equal(profile.contentSelector, '#articleContent');
  assert.deepEqual(plain(warnings), []);
});

test('detection ignores directory and article candidates under hidden ancestors', (t) => {
  const { api } = setup(
    t,
    '<div hidden><nav id="hidden-toc"><a href="one.html">One</a><a href="two.html">Two</a><a href="three.html">Three</a></nav><article id="hidden-body">Stale body</article></div>' +
      linkHTML,
  );
  const { profile } = api.detect({ entry: base.entry });
  assert.equal(profile.tocSelector, '#toc');
  assert.equal(profile.contentSelector, 'main');
});

test('invalid directory discovery returns an explicit error status with its original fault', async (t) => {
  const { api } = setup(t, linkHTML);
  const result = await api.discover({
    profile: { ...base, tocSelector: '#missing' },
    expand: false,
  });
  assert.equal(result.status, 'error');
  assert.match(result.error, /失效|不唯一/);
  assert.equal(result.fault.message, result.error);
  assert.equal(result.diagnostics.reason, 'invalid-directory');
});

test('reinjection blocks a legacy active picker until the user cancels it without synthesizing page events', async (t) => {
  const { w, doc, api } = setup(t, linkHTML);
  // The previous public API exposed pick but no dispose. Its private listeners
  // remain live even after another object replaces the global API.
  const { dispose: _dispose, ...legacyMethods } = api;
  const legacy = Object.freeze(legacyMethods);
  w.SecurityManualAdapters = legacy;
  let pageEvents = 0;
  for (const type of ['keydown', 'pagehide']) w.addEventListener(type, () => pageEvents++, true);
  const picking = legacy.pick({ kind: 'content', profile: base });
  const rejected = assert.rejects(picking, /取消/);
  w.eval(source);
  assert.equal(
    w.SecurityManualAdapters,
    legacy,
    'cannot replace an active picker without its cleanup API',
  );
  assert.match(w.SecurityManualAdapterInstallError, /旧版.*点选/);
  assert.match(w.SecurityManualAdapterInstallError, /Esc.*刷新/);
  assert.equal(doc.querySelectorAll('[data-security-picker]').length, 2);
  assert.equal(pageEvents, 0, 'upgrading must not dispatch keyboard or page lifecycle events');
  // A real user Escape has this same existing cancellation path.
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await rejected;
  assert.equal(doc.querySelector('[data-security-picker]'), null);
  w.eval(source);
  assert.notEqual(w.SecurityManualAdapters, legacy);
  assert.equal(w.SecurityManualAdapterInstallError, '');
  let clicks = 0;
  doc.querySelector('main button').onclick = () => clicks++;
  doc.querySelector('main button').click();
  assert.equal(clicks, 1);
  assert.equal(
    w.SecurityManualAdapters.detect({ entry: base.entry }).profile.contentSelector,
    'main',
  );
});

test('manual Ext sample picking uses anchor titles for both parent and chapter paths', async (t) => {
  const url = 'https://example.test/adocs.php';
  const { api, w, doc } = setup(
    t,
    '<ul class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><a class="x-tree-node-anchor" href="#"><span>Commands</span></a></div><ul class="x-tree-node-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item1"><a class="x-tree-node-anchor" href="#"><span id="pick-leaf">One</span></a></div></li></ul></li></ul><main>Body</main>',
    url,
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({ entry: url });
  const picking = api.pick({ kind: 'sample', profile });
  const outcome = Promise.race([
    picking,
    new Promise((resolve) => w.setTimeout(() => resolve(null), 60)),
  ]);
  doc
    .querySelector('#pick-leaf')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const sample = await outcome;
  if (!sample) {
    const cancelled = picking.catch(() => {});
    api.dispose();
    await cancelled;
  }
  assert.ok(sample, 'the chosen anchor chapter must resolve without waiting for picker timeout');
  assert.deepEqual(Array.from(sample.locator.path), ['Commands', 'One']);
  assert.equal(sample.locator.nodeId, 'api-menu-item1');
});

// Reduced from the authenticated CLI DOM inspected on 2026-10-13. Ext component
// IDs change on each chapter; the body and tree classes remain stable.
test('live CLI layout detects stable tree and body selectors across chapter replacement', async (t) => {
  const { w, doc, api } = setup(
    t,
    `
    <div class="af-api-menutree"><div><ul class="x-tree-root-ct">
      <li class="x-tree-node"><div class="x-tree-root x-tree-node-el" style="display:none"><span>root</span></div>
      <ul class="x-tree-node-ct"><li class="x-tree-node">
      <div class="x-tree-node-el x-tree-selected" data-id="api-menu-item34" leaf="true"><span class="x-tree-node-indent"></span><span>show cpu-usage</span></div>
      <ul class="x-tree-node-ct" style="display:none"></ul></li></ul></li>
    </ul></div></div>
    <div class="af-api-main-view"><div id="sfext3-comp-1047" class="af-api-body"><h2>show cpu-usage</h2><p>CPU usage manual</p></div></div>`,
    'https://example.test/cdocs.php?index=0&dataID=api-menu-item31',
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile, warnings } = api.detect({});
  assert.equal(profile.tocSelector, '.af-api-menutree');
  assert.equal(profile.contentSelector, '.af-api-body');
  assert.deepEqual(plain(warnings), []);
  const result = await api.discover({ profile, expand: false });
  assert.equal(result.items.length, 1);
  // The actual device replaces the component for each chapter.
  doc.querySelector(profile.contentSelector).outerHTML =
    '<div id="sfext3-comp-1090" class="af-api-body"><h2>show memory</h2></div>';
  assert.equal(doc.querySelector(profile.contentSelector).textContent, 'show memory');
});

test('unbranded nested lists and sibling article sections are detected from structure', async (t) => {
  const { doc, api } = setup(
    t,
    '<div><ul class="guide-tree"><li><span>Guide</span><ul><li><a href="one.html">One</a></li><li><a href="two.html">Two</a></li></ul></li></ul></div><section class="reader-content"><h1>One</h1><p>First chapter body.</p><pre>example</pre></section>',
  );
  const { profile } = api.detect({});
  assert.equal(doc.querySelector(profile.tocSelector)?.className, 'guide-tree');
  assert.equal(doc.querySelector(profile.contentSelector)?.className, 'reader-content');
  assert.equal((await api.discover({ profile, expand: false })).items.length, 2);
});
test('multiple unrelated article regions remain unconfirmed instead of capturing the whole page', (t) => {
  const { api } = setup(
    t,
    '<nav><a href="a">A</a><a href="b">B</a></nav><section><h1>A</h1><p>Alpha content</p></section><section><h1>B</h1><p>Bravo content</p></section>',
  );
  assert.equal(api.detect({}).profile.contentSelector, '');
});

test('region preflight identifies missing directory and ambiguous body without hiding their role', (t) => {
  const { api } = setup(t, linkHTML + '<main>Other body</main>');
  const result = api.bindings({ profile: { ...base, tocSelector: '#ext-gen-old' } });
  assert.equal(result.status, 'error');
  assert.deepEqual(plain(result.issues.map(({ region, count }) => ({ region, count }))), [
    { region: 'toc', count: 0 },
    { region: 'content', count: 2 },
  ]);
  assert.match(result.error, /目录.*0.*正文.*2/);
});

test('region preflight upgrades generated IDs only to selectors for the same observed nodes', (t) => {
  const { api, doc } = setup(
    t,
    '<nav id="ext-gen-11"><a href="one.html">One</a><a href="two.html">Two</a></nav><main id="sfext3-comp-42">Body</main>',
  );
  const profile = { ...base, tocSelector: '#ext-gen-11', contentSelector: '#sfext3-comp-42' };
  const result = api.bindings({ profile });
  assert.equal(result.status, 'ok');
  assert.equal(result.profile.tocSelector, 'nav');
  assert.equal(result.profile.contentSelector, 'main');
  assert.equal(
    doc.querySelector(result.profile.tocSelector),
    doc.querySelector(profile.tocSelector),
  );
  assert.equal(profile.tocSelector, '#ext-gen-11', 'preflight must not mutate a saved rule');
});

async function extBindingFixture(t, extra = '') {
  const { api, w, doc } = setup(
    t,
    '<nav id="other-nav">Other navigation</nav><ul id="chosen" class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item1"><span>Chosen</span></div></li></ul>' +
      extra +
      '<main>Body</main>',
    'https://example.test/adocs.php',
  );
  w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const { profile } = api.detect({});
  return { api, doc, profile: { ...profile, tocSelector: '#chosen' } };
}
const otherExtRoot =
  '<ul id="other-tree" class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item2"><span>Other</span></div></li></ul>';

test('Ext binding preflight permits roots ignored by the tree reader', async (t) => {
  const { api, profile } = await extBindingFixture(t, '<form>' + otherExtRoot + '</form>');
  const discovered = await api.discover({ profile, expand: false });
  assert.equal(discovered.diagnostics.roots, 1);
  assert.deepEqual(plain(discovered.items.map((item) => item.title)), ['Chosen']);
  assert.equal(api.bindings({ profile }).status, 'ok');
});

test('Ext binding preflight respects a unique selector among multiple roots', async (t) => {
  const { api, profile } = await extBindingFixture(t, otherExtRoot);
  const discovered = await api.discover({ profile, expand: false });
  assert.equal(discovered.diagnostics.roots, 1);
  assert.deepEqual(plain(discovered.items.map((item) => item.title)), ['Chosen']);
  assert.equal(api.bindings({ profile }).status, 'ok');
});

test('Ext root collections ignore excluded regions just like the reader', async (t) => {
  const { api, profile } = await extBindingFixture(t, '<form>' + otherExtRoot + '</form>');
  const result = api.bindings({ profile: { ...profile, tocSelector: '.x-tree-root-ct' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.directoryRoots, 1);
});

test('Ext binding preflight rejects a sole scanned root outside the selected directory', async (t) => {
  const { api, profile } = await extBindingFixture(t);
  const result = api.bindings({ profile: { ...profile, tocSelector: '#other-nav' } });
  assert.equal(result.status, 'error');
});

async function fiveRootFixture(t) {
  const roots = Array.from(
    { length: 5 },
    (_, index) =>
      `<ul id="tree-${index + 1}" class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item${index + 1}"><a class="x-tree-node-anchor" href="#">Chapter ${index + 1}</a></div></li></ul>`,
  ).join('');
  const p = setup(
    t,
    `<aside id="manual-directory">${roots}</aside><main>Body</main>`,
    'https://example.test/adocs.php',
  );
  p.w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  const detected = p.api.detect({}).profile;
  p.profile = { ...detected, tocSelector: '.x-tree-root-ct' };
  p.doc.querySelectorAll('a').forEach(
    (anchor) =>
      (anchor.onclick = (event) => {
        event.preventDefault();
        p.doc
          .querySelectorAll('.x-tree-selected')
          .forEach((row) => row.classList.remove('x-tree-selected'));
        anchor.parentElement.classList.add('x-tree-selected');
        p.doc.querySelector('main').textContent = 'Body of ' + anchor.textContent;
      }),
  );
  return p;
}
test('five Ext roots form one selected directory across discovery, open, current and proof', async (t) => {
  const p = await fiveRootFixture(t);
  assert.equal(p.api.bindings({ profile: p.profile }).status, 'ok');
  const scan = await p.api.discover({ profile: p.profile, expand: false });
  assert.deepEqual(plain(scan.items.map((item) => item.title)), [
    'Chapter 1',
    'Chapter 2',
    'Chapter 3',
    'Chapter 4',
    'Chapter 5',
  ]);
  const chapter = scan.items[4];
  assert.equal(p.api.open({ profile: p.profile, chapter }).clicked, true);
  assert.equal(p.api.current({ profile: p.profile }).chapter?.title, 'Chapter 5');
  assert.equal(p.api.verify({ profile: p.profile, chapter }).verified, true);
  assert.equal(p.doc.querySelector('main').textContent, 'Body of Chapter 5');
});
test('automatic Ext detection retains all five directory roots instead of the first tree', async (t) => {
  const p = await fiveRootFixture(t);
  const profile = p.api.detect({}).profile;
  const scan = await p.api.discover({ profile, expand: false });
  assert.equal(scan.items.length, 5);
  assert.equal(p.api.open({ profile, chapter: scan.items[4] }).clicked, true);
  assert.equal(p.api.verify({ profile, chapter: scan.items[4] }).verified, true);
});
test('Ext selector collection can grow from one root to five between chapter clicks', async (t) => {
  const p = await fiveRootFixture(t);
  const tails = [...p.doc.querySelectorAll('.x-tree-root-ct')].slice(1);
  tails.forEach((root) => root.remove());
  const first = await p.api.discover({ profile: p.profile, expand: false });
  assert.equal(first.items.length, 1);
  p.doc.querySelector('#manual-directory').append(...tails);
  assert.equal(p.api.open({ profile: p.profile, chapter: first.items[0] }).clicked, true);
  const all = await p.api.discover({ profile: p.profile, expand: false });
  assert.equal(all.items.length, 5);
  assert.equal(p.api.open({ profile: p.profile, chapter: all.items[4] }).clicked, true);
});
test('duplicate chapter paths across selected Ext roots cannot produce a navigation proof', async (t) => {
  const p = await fiveRootFixture(t);
  const chapter = {
    url: p.profile.entry,
    title: 'Chapter 1',
    locator: { kind: 'sangfor-ext-tree', path: ['Chapter 1'], nodeId: 'api-menu-item1' },
  };
  p.doc.querySelector('#tree-2 a').textContent = 'Chapter 1';
  p.doc.querySelector('#tree-1 .x-tree-node-el').classList.add('x-tree-selected');
  assert.equal(p.api.verify({ profile: p.profile, chapter }).verified, false);
  assert.equal(p.api.open({ profile: p.profile, chapter }).clicked, false);
  assert.equal(p.doc.querySelector('main').textContent, 'Body');
});
test('explicit Ext directory scope excludes other roots from every navigation operation', async (t) => {
  const p = await fiveRootFixture(t);
  const profile = { ...p.profile, tocSelector: '#tree-1' };
  const scan = await p.api.discover({ profile, expand: false });
  assert.deepEqual(plain(scan.items.map((item) => item.title)), ['Chapter 1']);
  const outside = {
    url: profile.entry,
    title: 'Chapter 5',
    locator: { kind: 'sangfor-ext-tree', path: ['Chapter 5'], nodeId: 'api-menu-item5' },
  };
  p.doc.querySelector('#tree-5 .x-tree-node-el').classList.add('x-tree-selected');
  assert.equal(p.api.verify({ profile, chapter: outside }).verified, false);
  assert.equal(p.api.open({ profile, chapter: outside }).clicked, false);
  assert.equal(p.api.current({ profile }).status, 'error');
});

test('manual sample picking ignores duplicate paths outside the configured Ext directory', async (t) => {
  const p = await fiveRootFixture(t);
  p.doc.querySelector('#tree-2 a').textContent = 'Chapter 1';
  const picking = p.api.pick({ kind: 'sample', profile: { ...p.profile, tocSelector: '#tree-1' } });
  const outcome = Promise.race([
    picking,
    new Promise((resolve) => p.w.setTimeout(() => resolve(null), 60)),
  ]);
  p.doc
    .querySelector('#tree-1 a')
    .dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const sample = await outcome;
  if (!sample) {
    const stopped = picking.catch(() => {});
    p.api.dispose();
    await stopped;
  }
  assert.equal(sample?.locator?.nodeId, 'api-menu-item1');
});
test('directory expansion includes unloaded branches in the fifth Ext root', async (t) => {
  const p = await fiveRootFixture(t);
  p.doc.querySelector('#tree-5').innerHTML =
    '<li class="x-tree-node"><div class="x-tree-node-el"><img class="x-tree-ec-icon tree-has-child"><span>Fifth group</span></div><ul class="x-tree-node-ct"></ul></li>';
  let expansions = 0;
  p.doc.querySelector('#tree-5 img').onclick = () => {
    expansions++;
    p.doc.querySelector('#tree-5 .x-tree-node-ct').innerHTML =
      '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item51"><span>Loaded fifth</span></div></li>';
  };
  const result = await p.api.discover({ profile: p.profile, expand: true });
  assert.equal(expansions, 1);
  assert.equal(result.diagnostics.pendingBranches, 0);
  assert.equal(result.items.at(-1).title, 'Loaded fifth');
  assert.equal(result.items.length, 5);
});

test('Ext detection excludes article candidates containing any selected directory root', async (t) => {
  const p = await fiveRootFixture(t);
  const wrapper = p.doc.createElement('article');
  p.doc.querySelector('main').before(wrapper);
  wrapper.append(p.doc.querySelector('#tree-5'));
  const { profile } = p.api.detect({});
  assert.equal(p.doc.querySelector(profile.contentSelector), p.doc.querySelector('main'));
});

async function observedAPIGrids(t) {
  const p = setup(
    t,
    `<div class="af-api-menutree x-border-layout-ct"><div class="af-api-menutree-scroll x-border-panel"><div><ul class="x-tree-root-ct x-tree-lines"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item57"><span>2.1 用户登录</span></div></li><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item58"><span>2.2 用户注销</span></div></li></ul></div></div></div><div class="af-api-main-view"><div class="af-api-body"><h1>2.1 用户登录</h1><p>API request and response fields</p>${Array.from({ length: 4 }, (_, i) => `<div class="x-panel af-api-listviewgrid x-treegrid"><div class="x-panel-bwrap"><div class="x-panel-body x-panel-body-noheader"><div class="x-tree-root-ct x-treegrid-ct x-tree-arrows"><div class="x-grid3-header">参数</div><div class="x-treegrid-root-node">${i === 3 ? '<div class="x-tree-node-el">code</div><div class="x-tree-node-el">data</div>' : ''}</div></div></div></div></div>`).join('')}</div></div>`,
    'https://example.test/adocs.php',
  );
  p.w.eval(await fs.readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  return p;
}

test('observed API grid classes do not exclude the article from automatic recognition', async (t) => {
  const p = await observedAPIGrids(t);
  const { profile } = p.api.detect({});
  assert.equal(profile.adapterId, 'sangfor');
  assert.equal(profile.tocSelector, '.af-api-menutree');
  assert.equal(profile.contentSelector, '.af-api-body');
  const found = await p.api.discover({ profile, expand: false });
  assert.equal(found.items.length, 2);
  assert.equal(found.diagnostics.roots, 1);
});

test('old broad API bindings propose only the same navigation roots for queue revalidation', async (t) => {
  const p = await observedAPIGrids(t);
  const profile = {
    ...p.api.detect({}).profile,
    id: 'keep-id',
    tocSelector: '.x-tree-root-ct',
    contentSelector: '.af-api-body',
  };
  const checked = p.api.bindings({ profile });
  assert.equal(checked.status, 'ok');
  assert.equal(checked.profile.tocSelector, '.af-api-menutree');
  assert.equal(checked.directoryRoots, 1);
  assert.equal(profile.tocSelector, '.x-tree-root-ct');
  assert.equal(checked.profile.id, 'keep-id');
});

test('manual directory picking refuses the observed API parameter grid and keeps waiting for navigation', async (t) => {
  const p = await observedAPIGrids(t);
  const profile = p.api.detect({}).profile;
  let completed = false;
  const picked = p.api.pick({ kind: 'toc', profile });
  picked.then(
    () => (completed = true),
    () => (completed = true),
  );
  p.doc
    .querySelector('.x-grid3-header')
    .dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.equal(completed, false);
  p.doc
    .querySelector('.af-api-menutree span')
    .dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const result = await picked;
  assert.equal(p.doc.querySelector(result.selector).tagName, 'UL');
});

test('automatic Ext detection does not merge two independent navigation regions', async (t) => {
  const p = await fiveRootFixture(t);
  const separate = p.doc.createElement('nav');
  p.doc.querySelector('main').before(separate);
  separate.append(p.doc.querySelector('#tree-5'));
  const { profile, warnings } = p.api.detect({});
  assert.equal(profile.tocSelector, '');
  assert.ok(warnings.some((warning) => warning.includes('目录')));
});

test('automatic Ext detection does not add an unclassified article tree to the manual queue', async (t) => {
  const p = await fiveRootFixture(t);
  p.doc.querySelector('main').append(p.doc.querySelector('#tree-5'));
  const { profile } = p.api.detect({});
  const scan = await p.api.discover({ profile, expand: false });
  assert.deepEqual(plain(scan.items.map((item) => item.title)), [
    'Chapter 1',
    'Chapter 2',
    'Chapter 3',
    'Chapter 4',
  ]);
  assert.equal(
    profile.contentSelector,
    '',
    'unclassified article tree still requires content calibration',
  );
});
