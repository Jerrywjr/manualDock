import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { normalizeDocumentURL } from '../extension/profiles.js';
const source = await fs.readFile(new URL('../extension/capture.js', import.meta.url), 'utf8');
test('shared extraction accepts configured path/hash manuals and retains sanitized table/code content', async () => {
  const entry = 'https://manual.test/docs/index.html#/chapter-a';
  const profile = {
    adapterId: 'generic',
    entry,
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    queryKeys: [],
    hashMode: 'route',
    contentSelector: 'main',
  };
  const dom = new JSDOM(
    '<nav>MENU</nav><main><h1>A</h1><p>Body A</p><table><tr><th>参数</th></tr><tr><td>port</td></tr></table><pre>GET /example</pre><button>执行</button><input value="SECRET"><script>SECRET</script></main>',
    { url: entry, runScripts: 'outside-only' },
  );
  dom.window.SecurityManualAdapters = {
    normalizeURL: normalizeDocumentURL,
    verify: () => ({ verified: true, kind: 'url' }),
  };
  dom.window.eval(source);
  try {
    const r = await dom.window.ManualCapture.capture({
      entry,
      expectedURL: entry,
      profile,
      selector: 'main',
    });
    assert.equal(r.status, 'ok');
    assert.match(r.markdown, /port/);
    assert.match(r.markdown, /GET \/example/);
    assert.doesNotMatch(r.text, /MENU|SECRET|执行/);
  } finally {
    dom.window.close();
  }
});

const entry = 'https://manual.test/docs/start';
const generic = {
  schemaVersion: 1,
  id: 'test',
  revision: 1,
  adapterId: 'generic',
  entry,
  origin: 'https://manual.test',
  pathPrefix: '/docs',
  queryKeys: [],
  hashMode: 'none',
  tocSelector: '#toc',
  contentSelector: 'main',
  navigation: 'click',
};
function page(t, html, profile = generic) {
  const dom = new JSDOM(html, { url: entry, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.SecurityManualAdapters = {
    normalizeURL: normalizeDocumentURL,
    verify: () => ({ verified: true, kind: 'generic-toc' }),
  };
  dom.window.eval(source);
  return { doc: dom.window.document, w: dom.window, profile };
}
const read = (p) =>
  p.w.ManualCapture.readState({ entry, profile: p.profile, selector: p.profile.contentSelector });
const capture = (p) =>
  p.w.ManualCapture.capture({
    entry,
    expectedURL: entry,
    profile: p.profile,
    selector: p.profile.contentSelector,
  });

test('generic selected content excludes sibling frame documents and their text from capture and fingerprint', async (t) => {
  const p = page(
    t,
    '<nav id="toc">Directory</nav><main><h1>DOCUMENT_BODY</h1></main><iframe id="widget"></iframe>',
  );
  p.doc.querySelector('iframe').contentDocument.body.innerHTML =
    '<main>UNRELATED_WIDGET_TEXT</main>';
  const before = read(p);
  p.doc.querySelector('iframe').contentDocument.querySelector('main').textContent =
    'CHANGED_UNRELATED_WIDGET';
  assert.equal(
    read(p).signature,
    before.signature,
    'a sibling widget is outside the chosen article',
  );
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /DOCUMENT_BODY/);
  assert.doesNotMatch(result.text, /UNRELATED_WIDGET/);
});

test('generic selected content retains visible nested article frames but excludes hidden frames', async (t) => {
  const p = page(
    t,
    '<section id="article"><h1>Main article</h1><iframe id="included"></iframe><iframe id="hidden" style="display:none"></iframe></section>',
    { ...generic, contentSelector: '#article' },
  );
  p.doc.querySelector('#included').contentDocument.body.innerHTML =
    '<main>SELECTED_FRAME_BODY</main>';
  p.doc.querySelector('#hidden').contentDocument.body.innerHTML = '<main>HIDDEN_FRAME_BODY</main>';
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /SELECTED_FRAME_BODY/);
  assert.doesNotMatch(result.text, /HIDDEN_FRAME_BODY/);
});

test('generic custom directory inside main never becomes chapter text or changes the body fingerprint', async (t) => {
  const p = page(
    t,
    '<main><div id="toc"><div role="tab">DIRECTORY_A</div><div role="tab">DIRECTORY_B</div></div><section><h1>ARTICLE_BODY</h1></section></main>',
  );
  const before = read(p);
  p.doc.querySelector('#toc').append(p.doc.createTextNode('NEW_DIRECTORY_ROW'));
  assert.equal(read(p).signature, before.signature);
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /ARTICLE_BODY/);
  assert.doesNotMatch(result.text, /DIRECTORY/);
});

test('CSS-hidden generic panes are excluded and switching visibility changes the chapter fingerprint', async (t) => {
  const p = page(
    t,
    '<style>.hidden-pane{display:none}</style><nav id="toc">Directory</nav><main><section id="a">CHAPTER_A</section><section id="b" class="hidden-pane">CHAPTER_B</section></main>',
  );
  const first = read(p);
  p.doc.querySelector('#a').className = 'hidden-pane';
  p.doc.querySelector('#b').className = '';
  assert.notEqual(read(p).signature, first.signature);
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /CHAPTER_B/);
  assert.doesNotMatch(result.text, /CHAPTER_A/);
});

test('visible image source and alt changes participate in generic nonempty body fingerprints', (t) => {
  const p = page(
    t,
    '<style>.hidden-picture{display:none}</style><main><img id="diagram" src="a.png" alt="Topology A"><img class="hidden-picture" src="not-visible.png"></main>',
  );
  const first = read(p);
  assert.equal(first.nonEmpty, true);
  p.doc.querySelector('#diagram').src = 'b.png';
  const second = read(p);
  assert.notEqual(second.signature, first.signature);
  p.doc.querySelector('#diagram').alt = 'Topology B';
  const third = read(p);
  assert.notEqual(third.signature, second.signature);
  p.doc.querySelector('.hidden-picture').src = 'still-not-visible.png';
  assert.equal(read(p).signature, third.signature);
  p.doc.querySelector('#diagram').className = 'hidden-picture';
  assert.equal(read(p).nonEmpty, false);
});

test('generic image-only chapters retain the visible raster and exclude a CSS-hidden remote image', async (t) => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqcAAAAASUVORK5CYII=';
  const p = page(
    t,
    `<style>.hidden-picture{display:none}</style><main><img src="${png}" alt="Topology"><img class="hidden-picture" src="https://manual.test/private.png"></main>`,
  );
  let requests = 0;
  p.w.fetch = () => {
    requests++;
    throw new Error('hidden image must not be downloaded');
  };
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.equal(result.text, '');
  assert.equal(result.diagnostics.images.embedded, 1);
  assert.equal(result.diagnostics.images.found, 1);
  assert.equal(requests, 0);
  assert.match(result.html, /data:image\/png;base64/);
});

test('generic readState recognizes aria-busy only in the selected body and its ancestors', (t) => {
  const p = page(
    t,
    '<div id="widget" aria-busy="true">Unrelated</div><main><div id="toc" aria-busy="true">Directory</div><section id="busy">Body</section><div hidden aria-busy="true">Hidden</div></main>',
  );
  assert.equal(read(p).loading, false);
  p.doc.querySelector('#busy').setAttribute('aria-busy', 'true');
  assert.equal(read(p).loading, true);
  p.doc.querySelector('#busy').setAttribute('aria-busy', 'false');
  assert.equal(read(p).loading, false);
  p.doc.querySelector('main').setAttribute('aria-busy', 'true');
  assert.equal(read(p).loading, true);
  p.doc.querySelector('main').removeAttribute('aria-busy');
  p.doc.body.setAttribute('aria-busy', 'true');
  assert.equal(read(p).loading, true);
});

// The root/header ancestry mirrors the user's 2026-10-14 DOM probe. Cell
// contents are synthetic examples; this does not stand in for a device capture.
const parameterGrid = (rows, attributes = '') => `
  <div class="x-panel af-api-listviewgrid x-treegrid">
    <div class="x-panel-bwrap"><div class="x-panel-body x-panel-body-noheader">
      <div class="x-tree-root-ct x-treegrid-ct x-tree-arrows" ${attributes}>
        <div class="x-grid3-header"><table><tr><th>参数</th><th>类型</th><th>描述</th></tr></table></div>
        <div class="x-treegrid-root-node"><table><tbody>${rows}</tbody></table></div>
      </div>
    </div></div>
  </div>`;

test('calibrated body retains visible Ext parameter grids despite a legacy global directory selector', async (t) => {
  const p = page(
    t,
    `<style>.hidden-row { display:none }</style>
    <main><h1>Response parameters</h1>
      <ul class="x-tree-root-ct"><li class="x-tree-node-el">NAVIGATION_ONLY</li></ul>
      ${parameterGrid('')}${parameterGrid('')}${parameterGrid('')}
      ${parameterGrid(`
        <tr class="x-tree-node-el"><td>code</td><td>int</td><td>Error code</td></tr>
        <tr class="x-tree-node-el"><td>message</td><td>string</td><td>Error message</td></tr>
        <tr class="x-tree-node-el"><td>data</td><td>object</td><td>Response data</td></tr>
        <tr class="x-tree-node-el"><td>name</td><td>string</td><td id="description">Account name</td></tr>
        <tr class="x-tree-node-el"><td>authResult</td><td>string</td><td>Authentication result</td></tr>
        <tr class="x-tree-node-el"><td>cftoken</td><td>string</td><td>Session token description</td></tr>
        <tr class="x-tree-node-el"><td>namespace</td><td>string</td><td>Namespace description</td></tr>
        <tr class="x-tree-node-el hidden-row"><td>HIDDEN_PARAMETER</td></tr>
      `)}
      ${parameterGrid('<tr><td>HIDDEN_GRID</td></tr>', 'hidden')}
      <div class="ext-el-mask">MASK_TEXT</div>
      <form>${parameterGrid('<tr><td>FORM_SECRET</td></tr>')}<input value="INPUT_SECRET"></form>
      <div contenteditable="true">${parameterGrid('<tr><td>EDITABLE_SECRET</td></tr>')}</div>
      <button id="send">SEND_REQUEST</button><button id="example">OPEN_EXAMPLE</button>
      <div hidden><pre>FOLDED_EXAMPLE</pre></div>
    </main>`,
    { ...generic, tocSelector: '.x-tree-root-ct' },
  );
  let clicks = 0;
  let requests = 0;
  p.doc.addEventListener('click', () => clicks++);
  p.w.fetch = () => {
    requests++;
    throw new Error('parameter capture must not send requests');
  };
  const initial = read(p);
  p.doc.querySelector('#description').textContent = 'Updated account description';
  assert.notEqual(
    read(p).signature,
    initial.signature,
    'visible parameter changes affect readiness',
  );
  const parametersChanged = read(p);
  p.doc.querySelector('ul.x-tree-root-ct li').textContent = 'CHANGED_NAVIGATION_ONLY';
  assert.equal(
    read(p).signature,
    parametersChanged.signature,
    'navigation remains outside the body fingerprint',
  );
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  for (const value of [
    'code',
    'message',
    'data',
    'name',
    'authResult',
    'cftoken',
    'namespace',
    'Updated account description',
  ]) {
    assert.ok(result.text.includes(value), `plain text retains ${value}`);
    assert.ok(result.markdown.includes(value), `Markdown retains ${value}`);
  }
  const output = new JSDOM(result.html);
  t.after(() => output.window.close());
  assert.equal(output.window.document.querySelectorAll('th').length, 12);
  assert.equal(output.window.document.querySelectorAll('td').length, 21);
  assert.doesNotMatch(
    JSON.stringify(result),
    /NAVIGATION_ONLY|HIDDEN_PARAMETER|HIDDEN_GRID|MASK_TEXT|FORM_SECRET|INPUT_SECRET|EDITABLE_SECRET|SEND_REQUEST|OPEN_EXAMPLE|FOLDED_EXAMPLE/,
  );
  assert.equal(clicks, 0);
  assert.equal(requests, 0);
});

test('Ext parameter grid exception requires an independent unique selected body and respects explicit TOC rules', (t) => {
  const rows = '<tr class="x-tree-node-el"><td>GRID_CONTENT</td></tr>';
  const cases = [
    {
      html: `<main><h1>Body</h1>${parameterGrid(rows)}</main>`,
      profile: { ...generic, contentSelector: 'body' },
    },
    {
      html: `<main><h1>Body</h1>${parameterGrid(rows)}</main><main>Other</main>`,
      profile: generic,
    },
    {
      html: `<main><h1>Body</h1><section id="toc">${parameterGrid(rows)}</section></main>`,
      profile: generic,
    },
    { html: `<main><h1>Body</h1><nav>${parameterGrid(rows)}</nav></main>`, profile: generic },
    {
      html: `<main><h1>Body</h1><div class="x-tree-root-ct x-treegrid-ct">${rows}</div></main>`,
      profile: generic,
    },
  ];
  for (const { html, profile } of cases) {
    const p = page(t, html, profile);
    const before = read(p);
    for (const node of p.doc.querySelectorAll('td')) node.textContent = 'CHANGED_GRID_CONTENT';
    assert.equal(
      read(p).signature,
      before.signature,
      'unproven grid or explicit navigation stays excluded',
    );
  }
});

test('generic manual with a scoped directory also preserves the same supported parameter grid shape', async (t) => {
  const p = page(
    t,
    `<nav id="toc">Navigation</nav><main><h1>Body</h1>${parameterGrid('<tr class="x-tree-node-el"><td>visible-port</td><td>int</td><td>Port parameter</td></tr>')}</main>`,
  );
  const result = await capture(p);
  assert.equal(result.status, 'ok');
  assert.match(result.markdown, /visible-port/);
});

test('legacy directory collision does not hide a loading mask inside a confirmed document grid', (t) => {
  const p = page(
    t,
    `<main><h1>Body</h1>${parameterGrid('<tr class="x-tree-node-el"><td>Parameter</td></tr>')}</main>`,
    { ...generic, tocSelector: '.x-tree-root-ct' },
  );
  const initial = read(p);
  assert.equal(initial.loading, false);
  const mask = p.doc.createElement('div');
  mask.className = 'x-mask';
  mask.textContent = 'LOADING_MASK';
  p.doc.querySelector('.x-treegrid-root-node').append(mask);
  const loading = read(p);
  assert.equal(loading.loading, true);
  assert.equal(loading.signature, initial.signature, 'mask text does not become article content');
  mask.hidden = true;
  assert.equal(read(p).loading, false);
});

test('unconfigured capture keeps excluding Ext grids rather than guessing a document scope', (t) => {
  const p = page(
    t,
    `<main><h1>Body</h1>${parameterGrid('<tr class="x-tree-node-el"><td>Grid value</td></tr>')}</main>`,
  );
  const options = { entry: 'https://manual.test/adocs.php', selector: 'main' };
  const first = p.w.ManualCapture.readState(options);
  p.doc.querySelector('td').textContent = 'Different grid value';
  assert.equal(p.w.ManualCapture.readState(options).signature, first.signature);
});
