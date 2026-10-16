import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeURL,
  mergeLinks,
  contentHash,
  buildExports,
  hasMissingExamples,
} from '../extension/core.js';

const entry = 'https://manual.example.test/adocs.php';
const chapter = `${entry}?index=1&dataID=setup`;
const review = `${entry}?index=2&dataID=copy`;
const failed = `${entry}?index=3&dataID=broken`;
const pending = `${entry}?index=4&dataID=later`;

// Removing the query allowlist, pair rule, or origin/path check must fail these cases.
test('normalizeURL accepts only the manual root and complete chapter identities', () => {
  for (const raw of [entry, '/adocs.php', './adocs.php'])
    assert.equal(normalizeURL(raw, entry), entry);
  assert.equal(
    normalizeURL('?dataID=part_A-9&index=001#example', entry),
    `${entry}?index=1&dataID=part_A-9`,
  );
  assert.equal(normalizeURL('/adocs.php?index=1&amp;dataID=setup', entry), chapter);
  assert.equal(normalizeURL(chapter), chapter);
  const unsafe = [
    '',
    '#menu',
    `${entry}#menu`,
    '?index=1',
    '?dataID=setup',
    '?index=1&dataID=setup&action=delete',
    '?action=delete',
    '?index=1&dataID=setup&index=2',
    '?index=1&dataID=setup&dataID=other',
    '?index=-1&dataID=setup',
    '?index=1.2&dataID=setup',
    '?index=1e2&dataID=setup',
    '?index=1&dataID=',
    '?index=1&dataID=foo/bar',
    '?index=1&dataID=foo%26action%3Ddelete',
    '?index=1&dataID=setup&%69ndex=2',
    '?index=1&dataID=setup;action=delete',
    'https://other.example.test/adocs.php?index=1&dataID=setup',
    '/logout.php',
    'http://manual.example.test/adocs.php?index=1&dataID=setup',
    'https://user:pass@manual.example.test/adocs.php?index=1&dataID=setup',
    'javascript:alert(1)',
    'data:text/html,hello',
    '?index=1&dataID=se\ntup',
  ];
  for (const raw of unsafe) assert.equal(normalizeURL(raw, entry), null, raw);
});

test('mergeLinks preserves discovery order and saved progress while filling missing titles', () => {
  const existing = [{ url: chapter, title: '', status: 'failed', error: 'timeout', seed: true }];
  const found = [
    { url: `${entry}?dataID=setup&index=1#contents`, title: '安装' },
    { url: review, title: '配置' },
    { url: chapter, title: '覆盖标题' },
    { url: failed, title: '故障' },
    { url: `${entry}?index=4&dataID=x&action=delete`, title: '危险' },
  ];
  assert.deepEqual(mergeLinks(existing, found, entry), [
    { url: chapter, title: '安装', status: 'failed', error: 'timeout', seed: true },
    { url: review, title: '配置' },
    { url: failed, title: '故障' },
  ]);
  assert.equal(existing[0].title, '');
});

test('contentHash uses deterministic SHA-256 over exact UTF-8 content', async () => {
  assert.equal(
    await contentHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.notEqual(await contentHash('配置'), await contentHash('配置 '));
});

function partialJob() {
  return {
    schemaVersion: 1,
    entry,
    product: '',
    version: null,
    createdAt: '2026-09-15T12:00:00.000Z',
    updatedAt: '2026-09-15T12:10:00.000Z',
    status: 'interrupted',
    queue: [
      { url: chapter, title: '安装', status: 'captured', seed: true },
      { url: review, title: '疑似重复章节', status: 'review', error: '正文与其他章节相同' },
      { url: failed, title: '故障', status: 'failed', error: '导航超时' },
      { url: pending, title: '下一章', status: 'pending' },
    ],
    pages: {
      [chapter]: {
        status: 'ok',
        url: chapter,
        title: '安装',
        text: '安装步骤与配置说明',
        markdown: '安装步骤与配置说明\n\n![拓扑](data:image/png;base64,AAAA)',
        html: '<p>安装步骤与配置说明</p><img alt="拓扑" src="data:image/png;base64,AAAA">',
        links: [],
        warnings: ['一张图片加载失败'],
        diagnostics: { imageCount: 2 },
        hash: 'hash-1',
        capturedAt: '2026-09-15T12:01:00.000Z',
      },
      [review]: {
        status: 'ok',
        url: review,
        title: '疑似重复章节',
        text: '待核对的正文',
        markdown: '待核对的正文',
        html: '<p>待核对的正文</p>',
        links: [],
        warnings: [],
        diagnostics: {},
        hash: 'hash-2',
        capturedAt: '2026-09-15T12:02:00.000Z',
      },
    },
    discoveryWarnings: ['一处动态目录无法识别'],
    scanDiagnostics: { unmatchedMenuCount: 1 },
    cookies: 'should-never-be-exported',
    token: 'secret-token',
  };
}

// Counting review as captured or dropping unresolved states must fail this test.
test('exports preserve partial coverage, order, sources, warnings, and recoverable states', () => {
  const output = buildExports(partialJob());
  for (const value of Object.values(output)) assert.equal(typeof value, 'string');
  assert.match(output.markdown, /安装步骤与配置说明/);
  assert.match(output.markdown, /未知/);
  assert.match(output.markdown, /待核对/);
  assert.ok(output.markdown.indexOf('安装') < output.markdown.indexOf('疑似重复章节'));
  assert.match(output.markdown, /offline\.html/);
  assert.doesNotMatch(output.markdown, /data:image\/png;base64/);
  assert.match(output.html, /data:image\/png;base64,AAAA/);
  assert.match(output.report, /已采集正文[：:]\s*1/);
  assert.match(output.report, /待核对[：:]\s*1/);
  assert.match(output.report, /导航超时/);
  assert.match(output.report, /下一章/);
  assert.match(output.report, /一处动态目录无法识别/);
  assert.match(output.report, /一张图片加载失败/);
  assert.match(output.report, /无法确认全册完整/);
  const archive = JSON.parse(output.json);
  assert.equal(archive.schemaVersion, 1);
  assert.equal(archive.queue[1].status, 'review');
  assert.equal(archive.queue[0].seed, true);
  assert.equal(archive.pages[chapter].hash, 'hash-1');
  assert.equal(archive.pages[review].text, '待核对的正文');
  assert.deepEqual(archive.scanDiagnostics, { unmatchedMenuCount: 1 });
  assert.equal(archive.cookies, undefined);
  assert.equal(archive.token, undefined);
});

test('offline HTML escapes untrusted metadata and blocks network loading and scripts', () => {
  const job = partialJob();
  job.product = '<script>alert(1)</script>';
  job.queue[0].title = '<img src=https://example.test/x onerror=alert(2)>';
  const { html, markdown } = buildExports(job);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=https:\/\/example\.test/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(markdown, /<script>alert/);
});

test('a saved captured flag without a valid body is reported as unresolved', () => {
  const job = partialJob();
  delete job.pages[chapter];
  const { report, json } = buildExports(job);
  assert.match(report, /已采集正文[：:]\s*0/);
  assert.match(report, /正文缺失/);
  assert.equal(JSON.parse(json).queue[0].status, 'captured');
});

test('an empty job exports a usable archive without claiming completeness', () => {
  const output = buildExports({ entry, queue: [], pages: {} });
  assert.match(output.report, /无法确认全册完整/);
  assert.equal(JSON.parse(output.json).schemaVersion, 1);
  assert.match(output.markdown, /尚无/);
});

test('JSON retains resume settings and every unresolved queue status', () => {
  const job = partialJob();
  job.scanAt = '2026-09-15T12:00:30.000Z';
  job.selector = '#manual-body';
  job.queue[2].status = 'waiting_login';
  job.queue[3].status = 'processing';
  const archive = JSON.parse(buildExports(job).json);
  assert.equal(archive.scanAt, '2026-09-15T12:00:30.000Z');
  assert.equal(archive.selector, '#manual-body');
  assert.equal(archive.queue[2].status, 'waiting_login');
  assert.equal(archive.queue[3].status, 'processing');
});

test('Markdown plaintext fallback escapes raw HTML instead of introducing active markup', () => {
  const job = partialJob();
  job.pages[chapter].markdown = '';
  job.pages[chapter].text = '示例：<script>alert(1)</script>';
  const { markdown } = buildExports(job);
  assert.doesNotMatch(markdown, /<script>alert\(1\)<\/script>/);
  assert.match(markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('complex HTML tables reference offline images without embedding base64 in Markdown', () => {
  const job = partialJob();
  const table =
    '<table><tbody><tr><td rowspan="2"><img alt="A > B &amp; &quot;拓扑&quot;" src="data:image/png;base64,AAAA"></td><td>说明</td></tr><tr><td><table><tr><td><img src="data:image/png;base64,BBBB"></td></tr></table></td></tr></tbody></table>';
  job.pages[chapter].markdown = `表格说明\n\n${table}`;
  job.pages[chapter].html = table;
  const { markdown, html } = buildExports(job);
  assert.doesNotMatch(markdown, /data:image\/png;base64/);
  assert.match(
    markdown,
    /<td rowspan="2"><a href="offline\.html#chapter-1">\[图片：A &gt; B &amp; &quot;拓扑&quot;，见离线 HTML\]<\/a><\/td>/,
  );
  assert.match(markdown, /未命名图片/);
  assert.match(markdown, /<table>/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /data:image\/png;base64,BBBB/);
});

test('replacing table images preserves literal table code examples', () => {
  const job = partialJob();
  const literal = '<table><tr><td><img src="data:image/png;base64,LITERAL"></td></tr></table>';
  const actual =
    '<table><tr><td rowspan="2"><img src="data:image/png;base64,ACTUAL"></td></tr></table>';
  job.pages[chapter].markdown = `\`\`\`html\n${literal}\n\`\`\`\n\n${actual}`;
  const { markdown } = buildExports(job);
  assert.ok(markdown.includes(literal));
  assert.doesNotMatch(markdown, /data:image\/png;base64,ACTUAL/);
});

const tree = (path, extra = {}) => ({
  url: entry,
  title: path.at(-1),
  locator: { kind: 'sangfor-ext-tree', path },
  ...extra,
});
const onePath = ['1 Overview', '1.1 Setup'];
const oneKey = 'toc:%5B%221%20Overview%22%2C%221.1%20Setup%22%5D';

test('tree chapters with the same URL keep separate stable identities and reject invalid locators', () => {
  const first = tree(onePath);
  const second = tree(['2 Overview', '2.1 Setup']);
  const invalid = [
    { kind: 'javascript', path: onePath },
    { kind: 'sangfor-ext-tree', path: [] },
    { kind: 'sangfor-ext-tree', path: Array(13).fill('x') },
    { kind: 'sangfor-ext-tree', path: [''] },
    { kind: 'sangfor-ext-tree', path: [' '.repeat(2)] },
    { kind: 'sangfor-ext-tree', path: ['x'.repeat(201)] },
    { kind: 'sangfor-ext-tree', path: [17] },
    { kind: 'sangfor-ext-tree', path: onePath, nodeId: 'logout' },
  ];
  for (const locator of invalid)
    assert.deepEqual(mergeLinks([], [tree(onePath, { locator })], entry), []);
  const merged = mergeLinks(
    [],
    [first, second, first, ...invalid.map((locator) => tree(onePath, { locator }))],
    entry,
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].key, oneKey);
  assert.deepEqual(merged[0].locator, first.locator);
  assert.notEqual(merged[0].key, merged[1].key);
  assert.equal(merged[0].url, entry);
  const reopened = mergeLinks(JSON.parse(JSON.stringify(merged)), [first, second], entry);
  assert.deepEqual(reopened, merged);
});

test('a numbered tree title upgrades only one matching legacy chapter without losing its progress', () => {
  const previous = {
    url: chapter,
    title: '1.1 Setup',
    status: 'captured',
    error: 'kept',
    seed: true,
  };
  const incoming = tree(onePath, { status: 'pending', error: 'discarded' });
  const merged = mergeLinks([previous], [incoming], entry);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, chapter);
  assert.equal(merged[0].key, chapter);
  assert.equal(merged[0].status, 'captured');
  assert.equal(merged[0].error, 'kept');
  assert.deepEqual(merged[0].locator, incoming.locator);
  assert.equal(previous.locator, undefined);
  assert.equal(mergeLinks(merged, [incoming], entry).length, 1);
  assert.equal(mergeLinks([{ ...previous, title: 'Setup' }], [tree(['Setup'])], entry).length, 2);
  assert.equal(mergeLinks([previous, { ...previous, url: review }], [incoming], entry).length, 3);
});

test('tree exports preserve identities and render each saved body with its actual source and directory path', () => {
  const second = tree(['2 Overview', '2.1 Setup']);
  const twoKey = 'toc:%5B%222%20Overview%22%2C%222.1%20Setup%22%5D';
  const job = {
    entry,
    queue: [
      { ...tree(onePath), key: oneKey, status: 'captured' },
      { ...second, key: twoKey, status: 'captured' },
    ],
    pages: {
      [oneKey]: { status: 'ok', url: chapter, text: 'Unique first body' },
      [twoKey]: { status: 'ok', url: entry, text: 'Unique second body' },
    },
  };
  const output = buildExports(job);
  const archive = JSON.parse(output.json);
  assert.equal(archive.queue[0].key, oneKey);
  assert.deepEqual(archive.queue[0].locator.path, onePath);
  assert.equal(archive.pages[oneKey].url, chapter);
  for (const rendered of [output.markdown, output.html]) {
    assert.match(rendered, /Unique first body/);
    assert.match(rendered, /Unique second body/);
    assert.match(rendered, /目录路径/);
    assert.match(rendered, /1 Overview/);
  }
  assert.match(output.report, /已采集正文：2/);
  assert.ok(output.report.includes(chapter));
});

test('export reports a saved example title with no body instead of hiding the omission', () => {
  const page = {
    status: 'ok',
    text: '请求样例',
    markdown: '请求样例',
    html: '<div><div><span></span>请求样例</div></div>',
  };
  const job = {
    queue: [{ url: chapter, title: 'Example', status: 'captured' }],
    pages: { [chapter]: page },
  };
  const before = JSON.stringify(job);
  const output = buildExports(job);
  for (const key of ['markdown', 'html', 'report']) assert.match(output[key], /样例只有标题/);
  assert.equal(JSON.stringify(job), before, 'export must not rewrite stored pages');
});

test('missing-example detection requires the observed empty shell, not a label mentioned in prose', () => {
  assert.equal(hasMissingExamples({ html: '<p>请求样例</p><pre>GET /example</pre>' }), false);
  assert.equal(
    hasMissingExamples({
      html: '<div><div><span></span>请求样例</div><div><pre>GET /example</pre></div></div>',
    }),
    false,
  );
  assert.equal(
    hasMissingExamples({ html: '<div><div><span></span>返回样例<span>成功\n </span></div></div>' }),
    true,
  );
  assert.equal(hasMissingExamples(null), false);
});
