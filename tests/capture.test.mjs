import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/capture.js', import.meta.url), 'utf8').catch(
  (error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  },
);
const ENTRY = 'https://manual.test/adocs.php';
const CURRENT = `${ENTRY}?index=10&dataID=docs`;
function page(markup, url = CURRENT) {
  const dom = new JSDOM(markup, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.eval(source);
  assert.equal(
    typeof dom.window.ManualCapture?.capture,
    'function',
    'capture module must expose its callable API',
  );
  return dom;
}
async function capture(dom, options = {}) {
  try {
    return await dom.window.ManualCapture.capture({
      entry: ENTRY,
      expectedURL: dom.window.location.href,
      ...options,
    });
  } finally {
    dom.window.close();
  }
}

test('discovers only observed manual URLs, never executes directory handlers or script text', async () => {
  const dom = page(`<nav>
    <a href="adocs.php?index=11&dataID=docs">Introduction</a>
    <span data-href="/adocs.php?index=12&dataID=docs">Setup</span>
    <span data-url="adocs.php?index=13&dataID=docs">Operation</span>
    <span onclick="window.called=true; openChapter('adocs.php?index=14&dataID=docs')">Chapter 14</span>
    <span onclick="openChapter(15)">Unmapped</span>
    <a href="adocs.php?index=16&dataID=docs&action=delete">Forbidden query</a>
    <a href="/logout.php">Log out</a>
    <a href="https://other.test/adocs.php?index=17&dataID=docs">External</a>
    <a href="javascript:location='/adocs.php?index=18&dataID=docs'">Script href</a>
    <a href="adocs.php?index=19&dataID=docs&index=20&dataID=docs">Duplicate argument</a>
    <script>window.location = 'adocs.php?index=21&dataID=docs'; const secret='SCRIPT_SECRET';</script>
    </nav><main><h1>Manual</h1><p>Read this chapter.</p></main>`);
  const result = await capture(dom, { scanOnly: true });
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    Array.from(result.links, (link) => new URL(link.url).searchParams.get('index')).sort(),
    ['11', '12', '13', '14'],
  );
  assert.ok(result.diagnostics.unmappedHandlers >= 1);
  assert.doesNotMatch(JSON.stringify(result), /SCRIPT_SECRET|window.called/);
});

test('preserves password API examples while stripping actual fields, credentials, scripts, and remote HTML resources', async () => {
  const dom =
    page(`<title>Password API reference</title><main style="background:url(https://remote.test/x)">
    <h1>Password API</h1><p>The password parameter is required.</p>
    <pre><code>{"password":"EXAMPLE_ONLY"}</code></pre>
    <input value="USER_SECRET"><textarea>FORM_SECRET</textarea><select><option>OPTION_SECRET</option></select>
    <script>const token='SCRIPT_SECRET'</script><style>body{background:url(https://remote.test/x)}</style>
    <a href="javascript:alert(1)" onclick="steal()" data-token="ATTR_SECRET">Read</a>
    <svg onload="steal()"><script>EVIL</script></svg><object data="https://remote.test/object"></object>
    <video src="https://remote.test/video"></video><link rel="stylesheet" href="https://remote.test/a.css">
    <div contenteditable="true">EDITABLE_SECRET</div><p aria-label="ARIA_SECRET" id="ATTR_SECRET">End</p>
    </main>`);
  Object.defineProperty(dom.window.document, 'cookie', {
    get() {
      throw new Error('cookie accessed');
    },
  });
  Object.defineProperty(dom.window, 'localStorage', {
    get() {
      throw new Error('storage accessed');
    },
  });
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.markdown, /EXAMPLE_ONLY/);
  assert.match(result.text, /password parameter/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /USER_SECRET|FORM_SECRET|OPTION_SECRET|SCRIPT_SECRET|ATTR_SECRET|ARIA_SECRET|EDITABLE_SECRET/,
  );
  const exported = new JSDOM(result.html).window.document;
  assert.equal(
    exported.querySelector(
      'script, style, input, textarea, select, object, iframe, svg, video, link',
    ),
    null,
  );
  assert.equal(exported.querySelector('[onclick], [style], [data-token], [contenteditable]'), null);
  assert.equal(exported.querySelector('a')?.getAttribute('href'), null);
});

test('reports actual login forms and authentication navigation as auth without leaking entered values', async () => {
  for (const fixture of [
    {
      html: '<form action="/login.php"><input name="user" value="SECRET_USER"><input type="password" value="SECRET_PASS"><button type="submit">登录</button></form>',
      url: CURRENT,
    },
    { html: '<h1>Sign in</h1>', url: 'https://manual.test/login.php?token=SECRET_TOKEN' },
  ]) {
    const result = await capture(page(fixture.html, fixture.url), { expectedURL: CURRENT });
    assert.equal(result.status, 'auth');
    assert.equal(result.text, '');
    assert.equal(result.html, '');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
  }
});

test('waits for asynchronous chapter content and rejects the wrong chapter URL', async () => {
  const dom = page('<main></main>');
  dom.window.setTimeout(() => {
    dom.window.document.querySelector('main').innerHTML = '<h1>Loaded chapter</h1><p>Late text</p>';
  }, 120);
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Late text/);
  const mismatch = await capture(page('<main><h1>Other chapter</h1></main>'), {
    expectedURL: `${ENTRY}?index=99&dataID=docs`,
  });
  assert.equal(mismatch.status, 'error');
  assert.equal(mismatch.diagnostics.reason, 'url-mismatch');
});

test('keeps headings, nested lists, fenced code, simple tables and merged cells', async () => {
  const dom = page(`<nav>Navigation</nav><main><h1>Installation</h1><h2>Steps</h2>
    <ol><li>Start<ul><li>Choose a device</li></ul></li><li>Finish</li></ol>
    <pre><code class="language-json">{"code":"\u0060\u0060\u0060","password":"sample"}</code></pre>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>a|b</td><td>1</td></tr></table>
    <table><tr><th colspan="2">Merged</th></tr><tr><td>A</td><td>B</td></tr></table></main>`);
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.markdown, /# Installation/);
  assert.match(result.markdown, /## Steps/);
  assert.match(result.markdown, /1\. Start\n\s+- Choose a device/);
  assert.match(result.markdown, /````json/);
  assert.match(result.markdown, /\| Name \| Value \|\n\| --- \| --- \|/);
  assert.match(result.markdown, /a\\\|b/);
  assert.match(result.markdown, /colspan="2"/);
  assert.doesNotMatch(result.text, /Navigation/);
});

test('collects same-origin iframe content and directory links, and warns on inaccessible frames', async () => {
  const dom = page('<iframe></iframe><iframe src="https://other.test/frame"></iframe>');
  const frame = dom.window.document.querySelector('iframe');
  frame.contentDocument.body.innerHTML =
    '<main><h1>Framed chapter</h1><p>Frame text</p><a href="/adocs.php?index=30&dataID=docs">Next</a></main>';
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Frame text/);
  assert.ok(result.links.some((link) => link.url === `${ENTRY}?index=30&dataID=docs`));
  assert.ok(result.warnings.some((warning) => /iframe|框架/i.test(warning)));
  assert.equal(new JSDOM(result.html).window.document.querySelector('iframe'), null);
});

test('scanOnly never downloads images; capture embeds only bounded same-origin static images', async () => {
  const markup =
    '<main><h1>Images</h1><img src="/diagram.png" alt="Diagram"><img src="https://other.test/pixel.png" alt="External"><img src="/logout.php" alt="Unsafe"><img src="/redirect.jpg" alt="Redirect"></main>';
  let calls = [];
  const makePage = () => {
    const dom = page(markup);
    dom.window.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('redirect.jpg')) throw new Error('redirect refused');
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    return dom;
  };
  const scanned = await capture(makePage(), { scanOnly: true });
  assert.equal(scanned.status, 'ok');
  assert.equal(calls.length, 0);
  const result = await capture(makePage());
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://manual.test');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'same-origin');
  }
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /src="https?:|src="\//);
  assert.ok(result.warnings.length >= 3);
});

test('never embeds active SVG content, oversize images, or non-image responses', async () => {
  const dom = page(
    '<main><h1>Diagrams</h1><img src="/evil.svg"><img src="/large.png"><img src="/html.png"></main>',
  );
  dom.window.fetch = async (url) => {
    if (url.endsWith('evil.svg'))
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><image href="https://other.test/x.png"/><script>SECRET_SCRIPT</script><text>Safe text</text></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } },
      );
    if (url.endsWith('large.png'))
      return new Response('x', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3000000' },
      });
    return new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
  };
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.ok(result.warnings.length >= 2);
  const doc = new JSDOM(result.html).window.document;
  assert.equal(
    doc.querySelectorAll('img').length,
    1,
    'the sanitized SVG must remain as an embedded image',
  );
  for (const img of doc.querySelectorAll('img')) {
    const raw = img.getAttribute('src') || '';
    if (raw.startsWith('data:image/svg+xml;base64,')) {
      const svg = Buffer.from(raw.split(',')[1], 'base64').toString('utf8');
      assert.doesNotMatch(svg, /onload|<script|https:\/\/other|SECRET_SCRIPT/);
    }
  }
});

test('reports empty pages, invalid selectors and body fallback without fabricating chapters', async () => {
  const empty = await capture(page('<script>secret()</script><input value="SECRET">'));
  assert.equal(empty.status, 'error');
  assert.equal(empty.diagnostics.reason, 'empty-content');
  const invalid = await capture(page('<main><p>Text</p></main>'), { selector: '[' });
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.diagnostics.reason, 'invalid-selector');
  const fallback = await capture(page('<div><h1>Plain chapter</h1><p>Useful text</p></div>'));
  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.diagnostics.selected, 'body');
  assert.ok(fallback.warnings.length > 0);
});

test('waits for the selected article rather than mistaking a loaded navigation bar for content', async () => {
  const dom = page(
    '<div class="sidebar"><a href="adocs.php?index=11&dataID=docs">Already loaded navigation</a></div><main></main>',
  );
  dom.window.setTimeout(() => {
    dom.window.document.querySelector('main').innerHTML =
      '<h1>Delayed article</h1><p>Actual chapter body</p>';
  }, 650);
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Actual chapter body/);
});

test('waits for same-origin iframe article content after the parent document is ready', async () => {
  const dom = page('<iframe></iframe>');
  const child = dom.window.document.querySelector('iframe').contentDocument;
  child.body.innerHTML = '<main></main>';
  dom.window.setTimeout(() => {
    child.querySelector('main').innerHTML =
      '<h1>Frame loaded later</h1><p>Complete framed content</p>';
  }, 650);
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Complete framed content/);
});

test('limits image count, detects streamed oversize responses and rejects mislabeled image bytes', async () => {
  const dom = page(
    `<main><h1>Lots of images</h1>${Array.from({ length: 41 }, (_, i) => `<img src="/asset-${i}.png">`).join('')}</main>`,
  );
  let calls = 0;
  dom.window.fetch = async () => {
    calls += 1;
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      headers: { 'Content-Type': 'image/png' },
    });
  };
  const result = await capture(dom);
  assert.equal(calls, 40);
  assert.equal(result.diagnostics.images.embedded, 40);
  assert.equal(result.diagnostics.images.missing, 1);
  assert.match(result.html, /图片未保存/);
  const oversized = page(
    '<main><h1>Unsafe images</h1><img src="/too-big.png"><img src="/fake.png"></main>',
  );
  oversized.window.fetch = async (url) =>
    new Response(
      url.endsWith('too-big.png')
        ? new Uint8Array(2 * 1024 * 1024 + 1)
        : '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://bad.test/x"/></svg>',
      { headers: { 'Content-Type': 'image/png' } },
    );
  const rejected = await capture(oversized);
  assert.equal(rejected.diagnostics.images.embedded, 0);
  assert.equal(rejected.diagnostics.images.missing, 2);
});

test(
  'times out stalled image requests and completes with explicit missing-image records',
  { timeout: 9000 },
  async () => {
    const dom = page(
      '<main><h1>Stalled image</h1><img src="/stalled.png" alt="Slow diagram"></main>',
    );
    let aborted = false;
    dom.window.fetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const result = await capture(dom);
    assert.equal(result.status, 'ok');
    assert.equal(aborted, true);
    assert.equal(result.diagnostics.images.missing, 1);
    assert.match(result.html, /图片未保存/);
  },
);

test(
  'fetches multiple images concurrently instead of one after another',
  { timeout: 9000 },
  async () => {
    const dom = page(
      '<main><h1>Concurrent images</h1><img src="/a.png"><img src="/b.png"><img src="/c.png"></main>',
    );
    let active = 0;
    let maxActive = 0;
    dom.window.fetch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    const result = await capture(dom);
    assert.equal(result.diagnostics.images.embedded, 3);
    assert.ok(maxActive >= 3, 'all images should be fetched at the same time, not serially');
  },
);

test('normalizes only complete index/dataID pairs and strips leading zeroes consistently with the exporter', async () => {
  const dom = page(`<main><h1>Directory</h1>
    <a href="?index=001&dataID=part_A-9#section">Valid</a>
    <a href="?index=2">Missing dataID</a><a href="?dataID=docs">Missing index</a>
    <a href="?index=abc&dataID=docs">Invalid index</a><a href="?index=2&dataID=a.b">Invalid dataID</a>
    <a href="#menu">Local menu</a></main>`);
  const result = await capture(dom, { scanOnly: true });
  assert.deepEqual(
    Array.from(result.links, (item) => item.url),
    [`${ENTRY}?index=1&dataID=part_A-9`],
  );
});

test('escapes literal HTML in Markdown prose while preserving fenced examples', async () => {
  const result = await capture(
    page(
      '<main><h1>Markup reference</h1><p>&lt;img src="https://other.test/pixel.png"&gt; &amp; ordinary text</p><pre><code>&lt;iframe src="https://other.test/frame"&gt;</code></pre></main>',
    ),
  );
  assert.equal(result.status, 'ok');
  assert.match(
    result.markdown,
    /&lt;img src="https:\/\/other.test\/pixel.png"&gt; &amp; ordinary text/,
  );
  assert.match(result.markdown, /```\n<iframe src="https:\/\/other.test\/frame">\n```/);
  assert.doesNotMatch(result.markdown.split('```')[0], /<img/);
});

test('ignores hidden login dialogs while recognizing visible login controls without a form tag', async () => {
  const hiddenDialog = await capture(
    page(
      '<div style="display:none"><form><input type="password" value="HIDDEN_SECRET"><button>登录</button></form></div><main><h1>API reference</h1><p>Documentation is available.</p></main>',
    ),
  );
  assert.equal(hiddenDialog.status, 'ok');
  assert.doesNotMatch(JSON.stringify(hiddenDialog), /HIDDEN_SECRET/);
  const visibleLogin = await capture(
    page(
      '<div><input type="text" value="SECRET_USER"><input type="password" value="SECRET_PASS"><button>登录</button></div>',
    ),
  );
  assert.equal(visibleLogin.status, 'auth');
  assert.equal(visibleLogin.html, '');
  assert.doesNotMatch(JSON.stringify(visibleLogin), /SECRET_/);
});

test('preserves spaces and paragraph indentation in list items with inline formatting', async () => {
  const result = await capture(
    page(
      '<main><h1>Steps</h1><ol><li>Click <code>Save</code> to apply<ul><li>Read <strong>all</strong> warnings</li></ul></li><li><p>First paragraph.</p><p>Second paragraph.</p></li></ol></main>',
    ),
  );
  assert.match(result.markdown, /1\. Click `Save` to apply/);
  assert.match(result.markdown, /\n   - Read \*\*all\*\* warnings/);
  assert.match(result.markdown, /2\. First paragraph\.\n\n   Second paragraph\./);
});

test('directory root may resolve to a same-manual default chapter while capture stays strict', async () => {
  const html =
    '<nav><a href="adocs.php?index=2&dataID=api-menu-item52">下一章</a></nav><main><h1>默认章节</h1><p>有效正文</p></main>';
  const scanned = await capture(page(html), { expectedURL: ENTRY, scanOnly: true });
  assert.equal(scanned.status, 'ok');
  assert.equal(scanned.diagnostics.navigation.expectedURL, ENTRY);
  assert.equal(scanned.diagnostics.navigation.actualURL, CURRENT);
  assert.equal(scanned.diagnostics.navigation.acceptedDirectoryRedirect, true);
  assert.equal(scanned.links.length, 1);
  const body = await capture(page(html), { expectedURL: ENTRY });
  assert.equal(body.status, 'error');
  assert.equal(body.diagnostics.reason, 'url-mismatch');
});

test('directory scan rejects different chapters and unsafe redirects with redacted diagnostics', async () => {
  const html = '<main><h1>实际页面</h1><p>不会采集成请求的章节。</p></main>';
  const changed = await capture(page(html), {
    expectedURL: ENTRY + '?index=99&dataID=docs',
    scanOnly: true,
  });
  assert.equal(changed.status, 'error');
  assert.equal(changed.diagnostics.navigation.actualURL, CURRENT);
  for (const destination of [
    'https://other.test/adocs.php?index=1&dataID=x',
    ENTRY + '?index=1&dataID=x&token=PRIVATE_SECRET',
    'https://manual.test/config.php?token=PRIVATE_SECRET',
  ]) {
    const result = await capture(page(html, destination), { expectedURL: ENTRY, scanOnly: true });
    assert.equal(result.status, 'error');
    assert.equal(result.diagnostics.reason, 'url-mismatch');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  }
});

test('directory structure includes event-bound and collapsed menu nodes without guessing links or changing the page', async () => {
  const dom = page(`<nav id="api-menu"><ul><li id="chapter-group" data-index="7">
    <span id="api-menu-item83" class="api-menu-item selected" role="treeitem" data-dataid="api-menu-item83">第七章</span>
    <ul hidden><li id="api-menu-item110" class="api-menu-item" data-index="19" data-data-id="api-menu-item110">折叠章节</li></ul>
    <div id="plain-row">没有链接的目录行</div></li></ul></nav>
    <div id="role-only" role="menuitem">角色目录项</div>
    <main><h1>正文标题</h1><p>正文不属于目录快照。</p><img src="/diagram.png"></main>`);
  let clicks = 0,
    requests = 0;
  dom.window.document.getElementById('api-menu-item83').addEventListener('click', () => clicks++);
  dom.window.fetch = async () => {
    requests++;
    throw new Error('diagnostic must not fetch');
  };
  const before = dom.window.document.documentElement.outerHTML;
  const result = await dom.window.ManualCapture.capture({
    entry: ENTRY,
    expectedURL: CURRENT,
    scanOnly: true,
    includeStructure: true,
  });
  assert.equal(result.status, 'ok');
  const snapshot = result.diagnostics.menuSnapshot;
  assert.ok(snapshot, 'requested diagnostics must include the observed menu structure');
  const row = snapshot.nodes.find((node) => node.id === 'api-menu-item83');
  const parent = snapshot.nodes.find((node) => node.id === 'chapter-group');
  assert.equal(row.text, '第七章');
  assert.equal(row.role, 'treeitem');
  assert.equal(row.class, 'api-menu-item selected');
  assert.equal(row.attributes['data-dataid'], 'api-menu-item83');
  assert.equal(parent.attributes['data-index'], '7');
  assert.equal(row.parentRef, parent.ref);
  assert.ok(row.order > parent.order);
  assert.equal(row.eventListeners, 'unknown');
  assert.equal(snapshot.nodes.find((node) => node.id === 'api-menu-item110').hidden, true);
  assert.ok(
    snapshot.nodes.some((node) => node.id === 'plain-row' && node.text === '没有链接的目录行'),
  );
  assert.ok(snapshot.nodes.some((node) => node.id === 'role-only'));
  assert.doesNotMatch(JSON.stringify(snapshot), /正文标题|正文不属于目录快照/);
  assert.deepEqual(Array.from(result.links), []);
  assert.equal(clicks, 0);
  assert.equal(requests, 0);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
  dom.window.close();
});

test('directory structure exports only explicit navigation evidence and sanitized handler summaries', async () => {
  const dom = page(`<nav id="directory">
    <button id="api-menu-item71" index="0007" dataID="api-menu-item71" data-token="DATA_SECRET" aria-label="ARIA_SECRET"
      onclick="openChapter(7, 'HANDLER_SECRET', 'adocs.php?index=7&amp;dataID=api-menu-item71'); log('FAKE_SECRET()'); /* COMMENT_SECRET() */">安全目录标题</button>
    <a id="unsafe-query" href="adocs.php?index=8&amp;dataID=x&amp;token=QUERY_SECRET">带额外参数</a>
    <a id="safe-link" href="?index=9&amp;dataID=api-menu-item73">真实链接</a>
    <span id="bad-fields" data-index="INDEX_SECRET" data-dataid="INVALID/SECRET" data-anything="OTHER_SECRET">无效字段</span>
    <form><span class="api-menu-item">FORM_SECRET</span><input value="INPUT_SECRET"><textarea>TEXTAREA_SECRET</textarea></form>
    <div contenteditable><span class="api-menu-item">EDITABLE_SECRET</span></div>
    <pre><code class="api-menu-item">CODE_SECRET</code></pre>
    <script>const password='SCRIPT_SECRET'</script>
    <main><div class="api-menu-item">BODY_SECRET</div></main>
  </nav><main><h1>手册</h1><p>正文</p></main>`);
  Object.defineProperty(dom.window.document, 'cookie', {
    get() {
      throw new Error('cookie read');
    },
  });
  Object.defineProperty(dom.window, 'localStorage', {
    get() {
      throw new Error('storage read');
    },
  });
  const getAttribute = dom.window.Element.prototype.getAttribute;
  dom.window.Element.prototype.getAttribute = function (name) {
    if (['data-token', 'data-anything', 'aria-label', 'value'].includes(name))
      throw new Error(`forbidden attribute ${name}`);
    return getAttribute.call(this, name);
  };
  const result = await capture(dom, { scanOnly: true, includeStructure: true });
  assert.equal(result.status, 'ok');
  const snapshot = result.diagnostics.menuSnapshot;
  assert.ok(snapshot, 'directory evidence must be available without serializing the DOM');
  const button = snapshot.nodes.find((node) => node.id === 'api-menu-item71');
  assert.equal(button.text, '安全目录标题');
  assert.equal(button.attributes.index, '0007');
  assert.equal(button.attributes.dataid, 'api-menu-item71');
  const call = button.onclick.calls.find((call) => call.name === 'openChapter');
  assert.deepEqual(Array.from(call.argumentTypes), ['number', 'string', 'string']);
  assert.deepEqual(Array.from(button.onclick.manualURLs), [
    `${ENTRY}?index=7&dataID=api-menu-item71`,
  ]);
  assert.equal(button.onclick.present, true);
  assert.ok(
    snapshot.nodes
      .find((node) => node.id === 'unsafe-query')
      .rejectedLinks.some((link) => link.reason === 'unsupported-query'),
  );
  assert.ok(
    snapshot.nodes
      .find((node) => node.id === 'safe-link')
      .links.some((link) => link.url === `${ENTRY}?index=9&dataID=api-menu-item73`),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /DATA_SECRET|ARIA_SECRET|HANDLER_SECRET|FAKE_SECRET|COMMENT_SECRET|QUERY_SECRET|INDEX_SECRET|INVALID\/SECRET|OTHER_SECRET|FORM_SECRET|INPUT_SECRET|TEXTAREA_SECRET|EDITABLE_SECRET|CODE_SECRET|SCRIPT_SECRET|BODY_SECRET/,
  );
});

test('directory structure identifies same-origin frame paths without exporting query secrets', async () => {
  const dom = page(
    '<iframe src="/menu.php?token=FRAME_SECRET"></iframe><iframe src="https://other.test/menu.php?token=EXTERNAL_SECRET"></iframe><main><h1>手册</h1></main>',
  );
  const child = dom.window.document.querySelector('iframe').contentDocument;
  child.open();
  child.write('<nav><span id="api-menu-item90" data-index="23">框架目录</span></nav>');
  child.close();
  const result = await capture(dom, { scanOnly: true, includeStructure: true });
  assert.equal(result.status, 'ok');
  const snapshot = result.diagnostics.menuSnapshot;
  assert.ok(snapshot, 'same-origin frame menus must be part of the snapshot');
  const row = snapshot.nodes.find((node) => node.id === 'api-menu-item90');
  const frame = snapshot.documents.find((item) => item.ref === row.documentRef);
  assert.equal(frame.url, 'https://manual.test/menu.php');
  assert.equal(frame.accessible, true);
  assert.equal(frame.parentRef, 'top');
  assert.ok(snapshot.documents.some((item) => !item.accessible && item.reason === 'cross-origin'));
  assert.doesNotMatch(JSON.stringify(result), /FRAME_SECRET|EXTERNAL_SECRET/);
});

test('directory structure reports candidate and traversal truncation instead of implying completeness', async () => {
  const menu = (count) =>
    '<nav>' +
    Array.from(
      { length: count },
      (_, n) => `<span id="api-menu-item${n}">${'章节文字'.repeat(50)}</span>`,
    ).join('') +
    '</nav><main><h1>手册</h1></main>';
  const bounded = await capture(page(menu(650)), { scanOnly: true, includeStructure: true });
  const snapshot = bounded.diagnostics.menuSnapshot;
  assert.ok(snapshot, 'bounded diagnostics must disclose how much was omitted');
  assert.ok(snapshot.totalCandidates >= 650);
  assert.equal(snapshot.exportedCount, snapshot.nodes.length);
  assert.ok(snapshot.nodes.length <= 600);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.traversalTruncated, false);
  assert.equal(snapshot.candidateCountIsLowerBound, false);
  assert.ok(snapshot.nodes.every((node) => node.text.length <= 120));
  const large = await capture(page(menu(13000)), { scanOnly: true, includeStructure: true });
  assert.equal(large.diagnostics.menuSnapshot.traversalTruncated, true);
  assert.equal(large.diagnostics.menuSnapshot.candidateCountIsLowerBound, true);
  assert.ok(large.diagnostics.menuSnapshot.visitedElements <= 12000);
  assert.ok(large.diagnostics.menuSnapshot.nodes.length <= 600);
});

test('ordinary directory scans do not include a structural snapshot without explicit opt-in', async () => {
  const result = await capture(
    page(
      '<nav><a href="?index=2&dataID=api-menu-item52">第二章</a></nav><main><h1>正文</h1></main>',
    ),
    { scanOnly: true },
  );
  assert.equal(result.diagnostics.menuSnapshot, undefined);
  assert.deepEqual(
    Array.from(result.links, (link) => link.url),
    [`${ENTRY}?index=2&dataID=api-menu-item52`],
  );
});

test('directory structure keeps positioned literal mapping evidence only for explicit navigation calls', async () => {
  const dom = page(`<nav><li id="api-menu-item83"
    onclick="openDoc(7, 'api-menu-item83', 'CALL_SECRET'); other(8, 'api-menu-item84'); openPage(9, 'api-menu-item85_BAD_SECRET')">字段在事件参数中</li></nav><main><h1>手册</h1></main>`);
  const result = await capture(dom, { scanOnly: true, includeStructure: true });
  const calls = result.diagnostics.menuSnapshot.nodes.find((node) => node.id === 'api-menu-item83')
    .onclick.calls;
  const navigation = calls.find((call) => call.name === 'openDoc');
  assert.ok(
    navigation.argumentEvidence,
    'navigation calls must retain safe positioned mapping evidence',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(navigation.argumentEvidence)), [
    { position: 0, type: 'integer', value: 7 },
    { position: 1, type: 'menu-id', value: 'api-menu-item83' },
  ]);
  assert.deepEqual(Array.from(calls.find((call) => call.name === 'other').argumentEvidence), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find((call) => call.name === 'openPage').argumentEvidence)),
    [{ position: 0, type: 'integer', value: 9 }],
  );
  assert.deepEqual(Array.from(result.links), []);
  assert.doesNotMatch(JSON.stringify(result), /CALL_SECRET|BAD_SECRET|api-menu-item84/);
});

test('directory structure traverses main wrappers and their frames without capturing article prose', async () => {
  const dom = page(
    '<main><aside><nav><span id="api-menu-item91">主容器中的目录</span></nav></aside><iframe></iframe><article><h1>BODY_TITLE_SECRET</h1><span class="api-menu-item">BODY_ROW_SECRET</span></article></main>',
  );
  dom.window.document.querySelector('iframe').contentDocument.body.innerHTML =
    '<nav><span id="api-menu-item92">框架中的目录</span></nav><p>框架已加载</p>';
  const result = await capture(dom, { scanOnly: true, includeStructure: true });
  assert.equal(result.status, 'ok');
  const snapshot = result.diagnostics.menuSnapshot;
  assert.ok(
    snapshot.nodes.some((node) => node.id === 'api-menu-item91'),
    'main wrappers must not hide nested navigation',
  );
  assert.ok(
    snapshot.nodes.some((node) => node.id === 'api-menu-item92'),
    'frames inside main must remain discoverable',
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /BODY_TITLE_SECRET|BODY_ROW_SECRET|框架已加载/);
});

test('directory structure declines template handler syntax without exposing nested literal contents', async () => {
  const result = await capture(
    page(
      '<nav><span id="api-menu-item93" onclick="openChapter(`x${`NESTED_HANDLER_SECRET()`}y`)">复杂事件</span></nav><main><h1>手册</h1></main>',
    ),
    { scanOnly: true, includeStructure: true },
  );
  const handler = result.diagnostics.menuSnapshot.nodes.find(
    (node) => node.id === 'api-menu-item93',
  ).onclick;
  assert.equal(handler.unsupportedSyntax, 'template-literal');
  assert.deepEqual(Array.from(handler.calls), []);
  assert.deepEqual(Array.from(handler.manualURLs), []);
  assert.doesNotMatch(JSON.stringify(result), /NESTED_HANDLER_SECRET/);
});

test('directory structure redacts rejected URL query values even when they appear in labels or the page title', async () => {
  const dom = page(`<title>目录 https://manual.test/adocs.php?token=TITLE_QUERY_SECRET</title><nav>
    <a id="absolute-label" href="adocs.php?token=QUERY_IN_LABEL_SECRET">https://manual.test/adocs.php?token=QUERY_IN_LABEL_SECRET</a>
    <a id="relative-label" href="adocs.php?token=RELATIVE_QUERY_SECRET">查看 adocs.php?token=RELATIVE_QUERY_SECRET</a>
    <a id="allowed-label" href="?index=4&amp;dataID=api-menu-item54">https://manual.test/adocs.php?index=4&amp;dataID=api-menu-item54</a>
  </nav><main><h1>手册</h1></main>`);
  const result = await capture(dom, { scanOnly: true, includeStructure: true });
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(
    JSON.stringify(result),
    /TITLE_QUERY_SECRET|QUERY_IN_LABEL_SECRET|RELATIVE_QUERY_SECRET/,
  );
  assert.match(
    result.diagnostics.menuSnapshot.nodes.find((node) => node.id === 'relative-label').text,
    /查看/,
  );
  assert.equal(
    result.diagnostics.menuSnapshot.nodes.find((node) => node.id === 'allowed-label').text,
    `${ENTRY}?index=4&dataID=api-menu-item54`,
  );
});

test('body extraction and readiness fingerprints exclude the real Ext directory tree', async () => {
  const dom = page(
    '<div class="x-tree-root-ct"><div class="x-tree-node-el">目录中的删除操作</div></div><div><h1>当前章节</h1><p>实际正文</p></div>',
  );
  assert.equal(typeof dom.window.ManualCapture.readState, 'function');
  const before = dom.window.ManualCapture.readState({ entry: ENTRY });
  dom.window.document.querySelector('.x-tree-node-el').textContent = '切换后的目录文字';
  assert.equal(dom.window.ManualCapture.readState({ entry: ENTRY }).signature, before.signature);
  const result = await capture(dom);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /实际正文/);
  assert.doesNotMatch(result.text, /目录中的|切换后的/);
  assert.doesNotMatch(result.html, /目录中的|切换后的/);
});

test('scan adds observed tree locators to discovery without manufacturing chapter URLs', async () => {
  const dom = page('<main><h1>手册</h1><p>正文</p></main>');
  const locator = { kind: 'sangfor-ext-tree', path: ['2 认证鉴权', '2.2 用户注销'] };
  dom.window.SangforTree = {
    scan: () => ({
      items: [{ url: ENTRY, title: '2.2 用户注销', locator }],
      diagnostics: { leaves: 1 },
      warnings: [],
    }),
  };
  const result = await capture(dom, { scanOnly: true });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, ENTRY);
  assert.deepEqual(result.links[0].locator, locator);
  assert.equal(result.diagnostics.tree.leaves, 1);
});

test('tree captures require selected-directory proof and retain the real source address', async () => {
  const locator = { kind: 'sangfor-ext-tree', path: ['2 认证鉴权', '2.2 用户注销'] };
  for (const verified of [false, true]) {
    const dom = page('<main><h1>正文标题</h1><p>正文内容</p></main>');
    dom.window.SangforTree = {
      verify: () => ({ kind: 'sangfor-ext-tree', path: locator.path, verified }),
    };
    const result = await capture(dom, { locator, chapterTitle: '2.2 用户注销' });
    assert.equal(result.status, verified ? 'ok' : 'error');
    if (verified) {
      assert.equal(result.navigationProof.verified, true);
      assert.equal(result.url, CURRENT);
      assert.equal(result.title, '2.2 用户注销');
    } else assert.equal(result.diagnostics.reason, 'tree-selection-mismatch');
  }
});

test('visible password API and configuration examples are not login pages merely because they have submit buttons', async () => {
  for (const [action, label] of [
    ['', 'Try request'],
    ['/adocs.php', 'Save'],
    ['/api/authorization', 'Submit'],
    ['/adocs.php?next=/login', 'Submit'],
  ]) {
    const dom = page(
      `<main><h1>Password API reference</h1><p>This chapter explains request parameters.</p><form action="${action}"><input type="password" value="FORM_SECRET"><button type="submit">${label}</button></form><p>Reference body remains readable.</p></main>`,
    );
    assert.equal(dom.window.ManualCapture.readState({ entry: ENTRY }).auth, false);
    const result = await capture(dom);
    assert.equal(result.status, 'ok');
    assert.match(result.text, /Reference body remains readable/);
    assert.doesNotMatch(JSON.stringify(result), /FORM_SECRET|<form|<input|<button/);
  }
});

test('login forms inside hidden frame ancestry do not mark the visible manual as requiring login', async () => {
  for (const [nested, src] of [
    [false, ''],
    [true, ''],
    [false, '/login.php'],
  ]) {
    const dom = page(
      `<main><h1>Manual body</h1><p>Still readable.</p></main><div style="display:none"><iframe src="${src}"></iframe></div>`,
    );
    let child = dom.window.document.querySelector('iframe').contentDocument;
    child.open();
    child.write('<html><body></body></html>');
    child.close();
    if (nested) {
      child.body.innerHTML = '<iframe></iframe>';
      child = child.querySelector('iframe').contentDocument;
    }
    child.body.innerHTML =
      '<form action="/login.php"><input type="password" value="FRAME_SECRET"><button>登录</button></form>';
    assert.equal(dom.window.ManualCapture.readState({ entry: ENTRY }).auth, false);
    const result = await capture(dom);
    assert.equal(result.status, 'ok');
    assert.match(result.text, /Still readable/);
    assert.equal(result.diagnostics.settled, true);
    assert.doesNotMatch(JSON.stringify(result), /FRAME_SECRET/);
  }
});

test('real login forms and visible session-expiry layers still pause even while old manual content remains', async () => {
  const fixtures = [
    '<main><h1>Sign in</h1><form><input type="password" value="AUTH_SECRET"><button>登录</button></form></main>',
    '<main><h1>Sign in</h1><form><input type="password" value="AUTH_SECRET"><input type="submit" value="登 录"></form></main>',
    '<main><h1>Old chapter</h1><p>Previously loaded body.</p><div role="dialog" aria-modal="true"><p>会话已过期</p><form><input type="password" value="AUTH_SECRET"><button>重新登录</button></form></div></main>',
    '<main><h1>Old chapter</h1><p>Previously loaded body.</p></main><form action="/login.php"><input type="password" value="AUTH_SECRET"><button>Continue</button></form>',
    '<main><h1>Sign in</h1><form action="/session"><input type="password" value="AUTH_SECRET"><input type="submit"></form></main>',
    '<main><h1>Old chapter</h1><p>Previously loaded body.</p></main><iframe></iframe>',
  ];
  for (const fixture of fixtures) {
    const dom = page(fixture);
    const frame = dom.window.document.querySelector('iframe');
    if (frame)
      frame.contentDocument.body.innerHTML =
        '<form><input type="password" value="AUTH_SECRET"><button>登录</button></form>';
    assert.equal(dom.window.ManualCapture.readState({ entry: ENTRY }).auth, true);
    const result = await capture(dom);
    assert.equal(result.status, 'auth');
    assert.equal(result.text, '');
    assert.doesNotMatch(JSON.stringify(result), /AUTH_SECRET/);
  }
});

test('navigation-only mutations do not stall a calibrated article extraction', async () => {
  const dom = page(
    '<nav id="toc"><span id="ticker">0</span></nav><main><h1>Stable chapter</h1><p>Body</p></main>',
  );
  dom.window.eval(
    await readFile(new URL('../extension/manual-adapters.js', import.meta.url), 'utf8'),
  );
  const profile = {
    entry: CURRENT,
    origin: 'https://manual.test',
    pathPrefix: '/adocs.php',
    queryKeys: ['index', 'dataID'],
    hashMode: 'none',
    tocSelector: '#toc',
    contentSelector: 'main',
    adapterId: 'generic',
  };
  let tick = 0;
  dom.window.setInterval(() => {
    dom.window.document.querySelector('#ticker').textContent = String(++tick);
  }, 100);
  const result = await capture(dom, { profile, selector: 'main' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Stable chapter/);
  assert.equal(result.diagnostics.settled, true);
  assert.ok(
    result.diagnostics.waitedMs < 4000,
    'unrelated navigation activity must not consume the 8-second stability timeout',
  );
});

test('profile scanOnly keeps Ext chapter discovery inside the selected directory', async () => {
  const row = (id, title) =>
    `<ul id="${id}" class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><span>${title}</span></div></li></ul>`;
  const dom = page(
    row('selected', 'Inside') + row('unrelated', 'Outside') + '<main>Body</main>',
    ENTRY,
  );
  dom.window.eval(await readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  dom.window.eval(
    await readFile(new URL('../extension/manual-adapters.js', import.meta.url), 'utf8'),
  );
  const profile = {
    ...dom.window.SecurityManualAdapters.detect({ entry: ENTRY }).profile,
    tocSelector: '#selected',
  };
  const result = await capture(dom, { scanOnly: true, profile });
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    Array.from(result.links, (item) => item.title),
    ['Inside'],
  );
});

test('profile scanOnly reports an invalid Ext directory instead of succeeding with zero chapters', async () => {
  const dom = page('<main>Body</main>', ENTRY);
  dom.window.eval(await readFile(new URL('../extension/tree.js', import.meta.url), 'utf8'));
  dom.window.eval(
    await readFile(new URL('../extension/manual-adapters.js', import.meta.url), 'utf8'),
  );
  const profile = {
    ...dom.window.SecurityManualAdapters.detect({ entry: ENTRY }).profile,
    adapterId: 'sangfor',
    pathPrefix: '/adocs.php',
    queryKeys: ['index', 'dataID'],
    tocSelector: '#missing',
  };
  const result = await capture(dom, { scanOnly: true, profile });
  assert.equal(result.status, 'error');
  assert.match(result.error, /目录/);
  assert.equal(result.diagnostics.reason, 'invalid-directory');
  assert.equal(result.links.length, 0);
});
