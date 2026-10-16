import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { normalizeDocumentURL } from '../extension/profiles.js';
const source = await fs.readFile(new URL('../extension/capture.js', import.meta.url), 'utf8');
const entry = 'https://manual.test/docs/start';
const profile = {
  adapterId: 'generic',
  entry,
  origin: 'https://manual.test',
  pathPrefix: '/docs',
  queryKeys: [],
  hashMode: 'none',
  tocSelector: '#toc',
  contentSelector: 'main',
};
// Reduced from the two user-saved pages. The original JS/CSS downloads were
// login responses: event handlers and hidden-state CSS below are test doubles.
const example = (label, text, collapsed = true) =>
  `<div class="af-api-panel"><div class="af-api-panel-titlebar"><span class="af-api-panel-arrow ${collapsed ? 'af-api-panel-arrow-collapse' : ''}"></span>${label}</div><div class="${collapsed ? 'x-hide-display' : ''}"><pre class="af-api-panel-codebody"><code>${text}</code></pre></div></div>`;
const row = (name, children = '') =>
  `<tbody class="x-tree-node"><tr class="x-tree-node-el ${children ? 'x-tree-node-collapsed' : 'x-tree-node-leaf'}"><td class="x-treegrid-col"><span class="x-tree-node-indent"><img src="data:image/gif;base64,AA=="></span><img class="x-tree-ec-icon ${children ? 'x-tree-elbow-plus' : 'x-tree-elbow'}" src="data:image/gif;base64,AA=="><a>${name}</a></td><td>object</td><td>description</td></tr>${children ? `<tr class="x-tree-node-ct" style="display:none"><td colspan="3"><table class="x-treegrid-node-ct-table">${children}</table></td></tr>` : ''}</tbody>`;
const grid = (rows) =>
  `<div class="x-tree-root-ct x-treegrid-ct"><div class="x-grid3-header"><table><tr><th>参数</th><th>类型</th><th>描述</th></tr></table></div><div class="x-treegrid-root-node"><table>${rows}</table></div></div>`;
function page(t, body) {
  const dom = new JSDOM(
    `<style>.x-hide-display {display:none}</style><nav id="toc">DIRECTORY</nav><main><h1>Chapter</h1>${body}</main>`,
    { url: entry, runScripts: 'outside-only' },
  );
  t.after(() => dom.window.close());
  dom.window.SecurityManualAdapters = {
    normalizeURL: normalizeDocumentURL,
    verify: () => ({ verified: true }),
  };
  dom.window.eval(source);
  const options = { entry, profile, selector: 'main', expectedURL: entry };
  return { w: dom.window, doc: dom.window.document, options };
}
function wire(p, delay = 0) {
  p.doc.addEventListener('click', (event) => {
    const arrow = event.target.closest('.af-api-panel-arrow');
    if (arrow) {
      arrow.classList.remove('af-api-panel-arrow-collapse');
      setTimeout(
        () => arrow.parentElement.nextElementSibling.classList.remove('x-hide-display'),
        delay,
      );
    }
    const icon = event.target.closest('img.x-tree-ec-icon');
    if (icon) {
      const r = icon.closest('tr');
      r.classList.replace('x-tree-node-collapsed', 'x-tree-node-expanded');
      icon.classList.replace('x-tree-elbow-plus', 'x-tree-elbow-minus');
      setTimeout(() => {
        r.nextElementSibling.style.display = '';
      }, delay);
    }
  });
}
test('body preparation expands nested parameter rows and all three examples without clicking navigation or execution controls', async (t) => {
  const p = page(
    t,
    grid(row('data', row('items', row('DEEP_FIELD')))) +
      example('请求样例', 'REQUEST') +
      example('返回样例成功', 'SUCCESS') +
      example('返回样例失败', 'FAILURE') +
      '<button>EXECUTE</button><div hidden>UNRELATED_HIDDEN</div>',
  );
  wire(p, 40);
  const clicked = [];
  p.doc.addEventListener('click', (e) => clicked.push(e.target));
  const prepared = await p.w.ManualCapture.prepareContent(p.options);
  assert.equal(prepared.status, 'ok');
  assert.equal(prepared.clicked, 5);
  const captured = await p.w.ManualCapture.capture(p.options);
  assert.equal(captured.status, 'ok');
  for (const value of ['DEEP_FIELD', 'REQUEST', 'SUCCESS', 'FAILURE'])
    for (const format of ['text', 'html', 'markdown'])
      assert.ok(captured[format].includes(value), `${format} contains ${value}`);
  assert.doesNotMatch(captured.text, /DIRECTORY|EXECUTE|UNRELATED_HIDDEN|未命名图片/);
  assert.equal(captured.diagnostics.images.found, 0);
  assert.ok(clicked.every((el) => el.closest('main') && !el.closest('button,nav')));
  const again = await p.w.ManualCapture.prepareContent(p.options);
  assert.equal(again.clicked, 0);
});
test('example preparation reports a control that did not open instead of claiming complete content', async (t) => {
  const p = page(t, example('返回样例成功', 'MISSING'));
  const prepared = await p.w.ManualCapture.prepareContent(p.options);
  assert.equal(prepared.status, 'error');
  assert.match(prepared.error, /展开/);
});
test('body preparation does not operate hidden panels, forms, editable widgets or explicit navigation', async (t) => {
  const panel = example('请求样例', 'PRIVATE');
  const p = page(
    t,
    `<div hidden>${panel}</div><form>${panel}</form><div contenteditable="true">${panel}</div><nav>${panel}</nav>`,
  );
  let clicks = 0;
  p.doc.addEventListener('click', () => clicks++);
  assert.equal((await p.w.ManualCapture.prepareContent(p.options)).status, 'ok');
  assert.equal(clicks, 0);
});
test('body preparation rejects a replaced article during expansion', async (t) => {
  const p = page(t, example('请求样例', 'OLD'));
  p.doc.querySelector('.af-api-panel-arrow').addEventListener('click', () => {
    p.doc.querySelector('main').outerHTML = '<main>NEW_CHAPTER</main>';
  });
  const prepared = await p.w.ManualCapture.prepareContent(p.options);
  assert.equal(prepared.status, 'error');
  assert.match(prepared.error, /变化|替换/);
});
test('observed adjacent API code blocks retain the separator between request line and JSON body', async (t) => {
  const p = page(
    t,
    '<pre class="af-api-panel-codebody"><code>POST /api/items</code><code></code><code>{\n  "name": "example"\n}</code></pre>',
  );
  const captured = await p.w.ManualCapture.capture(p.options);
  assert.equal(captured.status, 'ok');
  assert.match(captured.markdown, /POST \/api\/items\n+\{/);
  assert.match(captured.html, /<\/code>\n+<code>/);
});

test('an expanded parameter icon is insufficient while its real child table remains hidden', async (t) => {
  const p = page(t, grid(row('parent', row('CHILD'))));
  const container = p.doc.querySelector('tr.x-tree-node-ct');
  container.style.display = '';
  container.querySelector('table').style.display = 'none';
  p.doc.querySelector('img.x-tree-ec-icon').addEventListener('click', (e) => {
    e.target.classList.replace('x-tree-elbow-plus', 'x-tree-elbow-minus');
    e.target.closest('tr').classList.replace('x-tree-node-collapsed', 'x-tree-node-expanded');
  });
  const result = await p.w.ManualCapture.prepareContent(p.options);
  assert.equal(result.status, 'error');
});

test('direct capture from an older caller prepares examples and nested fields without an opt-in flag', async (t) => {
  const p = page(
    t,
    grid(row('data', row('NESTED_FIELD'))) +
      example('请求样例', 'GET /example') +
      example('返回样例成功', '{"result":"OK"}') +
      example('返回样例失败', '{"error":"EXAMPLE"}'),
  );
  wire(p, 40);
  const captured = await p.w.ManualCapture.capture(p.options);
  assert.equal(captured.status, 'ok');
  for (const value of ['NESTED_FIELD', 'GET /example', '"result"', '"error"'])
    for (const format of ['text', 'html', 'markdown'])
      assert.ok(captured[format].includes(value), `${format}: ${value}`);
  assert.equal(captured.diagnostics.disclosures.checked, true);
  assert.equal(captured.diagnostics.disclosures.clicked, 4);
});

test('direct capture cannot silently save titles when disclosure clicks do nothing', async (t) => {
  const p = page(t, example('请求样例', 'MISSING'));
  const captured = await p.w.ManualCapture.capture(p.options);
  assert.equal(captured.status, 'error');
  assert.equal(captured.diagnostics.reason, 'content-expansion-incomplete');
  assert.equal(captured.html, '');
});

test('an expanded example wrapper is insufficient when its code remains hidden', async (t) => {
  const p = page(t, example('返回样例成功', 'MISSING', false));
  p.doc.querySelector('pre').style.display = 'none';
  const captured = await p.w.ManualCapture.capture({ ...p.options, requireExpanded: true });
  assert.equal(captured.status, 'error');
  assert.equal(captured.html, '');
});

test('read-only preview does not expand controls and cannot be mistaken for a saved chapter', async (t) => {
  const p = page(t, example('请求样例', 'UNOPENED'));
  wire(p);
  let clicks = 0;
  p.doc.addEventListener('click', () => clicks++);
  const result = await p.w.ManualCapture.capture({ ...p.options, previewOnly: true });
  assert.equal(clicks, 0);
  assert.equal(result.status, 'preview');
  assert.equal(result.diagnostics.disclosures.checked, false);
  assert.doesNotMatch(result.text, /UNOPENED/);
});
