import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTask, ImportEngine } from '../extension/engine.js';
import { validateProfile, specificationTaskId } from '../extension/profiles.js';
import { buildExports, contentHash } from '../extension/core.js';
import { parseSpecification } from '../extension/openapi.js';
import * as api from '../extension/archive.js';
const dom = new JSDOM('');
const restore = (text) => {
  assert.equal(typeof api.parseArchive, 'function');
  return api.parseArchive(text, { DOMParser: dom.window.DOMParser });
};
const profile = validateProfile({
  schemaVersion: 1,
  id: 'archive-profile',
  revision: 1,
  adapterId: 'generic',
  entry: 'https://manual.test/docs/',
  pathPrefix: '/docs/',
  tocSelector: 'nav',
  contentSelector: 'main',
});
function fixture() {
  const task = createTask(profile, 'Product', '1');
  new ImportEngine(task, {}).merge(
    ['one', 'two', 'three'].map((title) => ({ title, url: profile.entry + title })),
  );
  const [one, two, three] = task.queue;
  one.status = 'captured';
  two.status = 'processing';
  three.status = 'waiting_login';
  task.pages[one.key] = {
    status: 'ok',
    url: one.url,
    title: one.title,
    text: 'Saved body',
    markdown: '**Saved** body',
    html: '<p>Saved body</p>',
    hash: 'forged',
    capturedAt: '2026-10-10T00:00:00.000Z',
    navigationProof: { verified: true },
    diagnostics: { cookies: 'SECRET' },
    cookies: 'SECRET',
  };
  task.autoRecovery = { enabled: true, sourceTabId: 99 };
  task.cookies = 'SECRET';
  task.profile.cookies = 'SECRET';
  return task;
}
test('schema2 export restores saved pages and resumable progress without trusting live proof', async () => {
  const original = fixture(),
    restored = await restore(buildExports(original).json),
    key = restored.queue[0].key;
  assert.equal(restored.taskId, original.taskId);
  assert.deepEqual(
    restored.queue.map((c) => c.status),
    ['captured', 'pending', 'pending'],
  );
  assert.equal(restored.autoRecovery.enabled, false);
  assert.equal(restored.origin, 'restored');
  assert.equal(restored.pages[key].hash, await contentHash('Saved body'));
  assert.equal(restored.pages[key].markdown, '**Saved** body');
  assert.equal(restored.pages[key].capturedAt, '2026-10-10T00:00:00.000Z');
  assert.equal(restored.pages[key].origin, 'restored');
  assert.notEqual(restored.pages[key].navigationProof?.verified, true);
  assert.ok(!JSON.stringify(restored).includes('SECRET'));
});
test('archive HTML keeps tables code and raster images while excluding active and remote content', async () => {
  const task = fixture(),
    key = task.queue[0].key;
  task.pages[key].html =
    '<table onclick="bad()"><tr><td colspan="2"><pre><code>&lt;command&gt;</code></pre></td></tr></table><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" onerror="bad()"><img src="https://evil.test/pixel"><script>danger()</script><style>body{background:url(https://evil.test)}</style><iframe src="https://evil.test"></iframe><form><input value="PRIVATE"></form><svg onload="bad()"></svg><a href="javascript:bad()">unsafe</a><a href="https://example.test/help">safe</a>';
  task.pages[key].markdown = 'Useful **text** <script>alert(1)</script> [unsafe](javascript:bad())';
  const page = (await restore(JSON.stringify(task))).pages[key],
    doc = new dom.window.DOMParser().parseFromString(page.html, 'text/html');
  assert.equal(doc.querySelector('td').getAttribute('colspan'), '2');
  assert.equal(doc.querySelector('code').textContent, '<command>');
  assert.equal(doc.querySelectorAll('img').length, 1);
  assert.equal(page.diagnostics.images.embedded, 1);
  assert.equal(
    doc.querySelectorAll('script,style,iframe,form,input,svg,[onclick],[onerror],[onload]').length,
    0,
  );
  assert.equal(doc.querySelector('a').hasAttribute('href'), false);
  assert.equal(doc.querySelectorAll('a')[1].getAttribute('href'), 'https://example.test/help');
  assert.doesNotMatch(page.markdown, /<script|javascript:/i);
});
test('missing or unusable archived bodies never keep captured status', async () => {
  const task = fixture(),
    key = task.queue[0].key;
  delete task.pages[key];
  const absent = await restore(JSON.stringify(task));
  assert.equal(absent.queue[0].status, 'pending');
  assert.ok(absent.discoveryWarnings.some((w) => /正文/.test(w)));
  task.pages[key] = {
    status: 'ok',
    url: task.queue[0].url,
    text: '',
    html: '<script>only executable content</script>',
  };
  const invalid = await restore(JSON.stringify(task));
  assert.equal(invalid.queue[0].status, 'pending');
  assert.equal(invalid.pages[key], undefined);
});
for (const variant of [
  'duplicate',
  'wrong-task',
  'wrong-key',
  'outside-chapter',
  'outside-page',
  'extra-page',
  'wrong-profile',
])
  test('rejects archive identity inconsistency: ' + variant, async () => {
    const task = fixture(),
      key = task.queue[0].key;
    if (variant === 'duplicate') task.queue.push({ ...task.queue[0] });
    if (variant === 'wrong-task') task.taskId = 'unrelated';
    if (variant === 'wrong-key') task.queue[0].key = 'forged';
    if (variant === 'outside-chapter') task.queue[0].url = 'https://other.test/docs/';
    if (variant === 'outside-page') task.pages[key].url = 'https://other.test/docs/';
    if (variant === 'extra-page') task.pages.forbidden = { status: 'ok', text: 'foreign' };
    if (variant === 'wrong-profile') task.profileRevision = 2;
    await assert.rejects(restore(JSON.stringify(task)), /目录|章节|身份|范围|配置|任务|档案/);
  });
test('merge fills only missing pages and chapters and preserves local captured or review bodies', async () => {
  const local = await restore(buildExports(fixture()).json),
    incoming = await restore(buildExports(fixture()).json);
  local.storageRevision = 7;
  const [one, two, three] = incoming.queue;
  incoming.pages[one.key] = {
    ...incoming.pages[one.key],
    text: 'Conflicting archive',
    hash: 'different',
  };
  two.status = 'captured';
  incoming.pages[two.key] = {
    ...incoming.pages[one.key],
    url: two.url,
    text: 'Missing local body',
    hash: 'two',
  };
  incoming.queue.push({
    key: 'url:' + profile.entry + 'four',
    url: profile.entry + 'four',
    title: 'four',
    status: 'pending',
  });
  const saved = JSON.stringify(local.pages[one.key]),
    result = api.mergeArchive(local, incoming);
  assert.equal(result.addedPages, 1);
  assert.deepEqual(result.conflicts, [one.key]);
  assert.equal(result.task.queue.length, 4);
  assert.equal(result.task.pages[two.key].text, 'Missing local body');
  assert.equal(JSON.stringify(result.task.pages[one.key]), saved);
  assert.equal(result.task.storageRevision, 7);
  assert.equal(result.task.autoRecovery.enabled, false);
  assert.equal(local.queue.length, 3);
  local.queue[0].status = 'review';
  assert.equal(JSON.stringify(api.mergeArchive(local, incoming).task.pages[one.key]), saved);
  assert.throws(() => api.mergeArchive(local, { ...incoming, taskId: 'different' }), /任务|身份/);
});
test('local OpenAPI archives restore their operation identities without executing requests', async () => {
  const spec = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'API', version: '1' },
      paths: { '/status': { get: { responses: { 200: { description: 'OK' } } } } },
    }),
    parsed = parseSpecification(spec);
  const task = {
    schemaVersion: 2,
    sourceKind: 'openapi',
    taskId: specificationTaskId(
      await contentHash(spec),
      'file:api.json',
      parsed.title,
      parsed.version,
    ),
    entry: '本地文件:api.json',
    product: parsed.title,
    version: parsed.version,
    specVersion: parsed.specVersion,
    queue: parsed.queue,
    pages: parsed.pages,
  };
  const result = await restore(buildExports(task).json);
  assert.equal(result.queue[0].key, 'api:GET:/status');
  assert.equal(result.pages['api:GET:/status'].diagnostics.source, 'openapi');
  assert.equal(result.pages['api:GET:/status'].origin, 'restored');
  assert.equal(result.autoRecovery.enabled, false);
});
test('unsupported format oversized input and missing DOM parser fail before restoration', async () => {
  await assert.rejects(restore(JSON.stringify({ ...fixture(), schemaVersion: 1 })), /格式|版本/);
  await assert.rejects(restore('x'.repeat(128 * 1024 * 1024 + 1)), /128|大小/);
  await assert.rejects(
    api.parseArchive(buildExports(fixture()).json, { DOMParser: null }),
    /DOM|解析/,
  );
});

test('restored Markdown makes multiline HTML inert while retaining fenced examples', async () => {
  const task = fixture(),
    key = task.queue[0].key;
  task.pages[key].markdown =
    'Text\n<img\nsrc="https://evil.test"\nonerror="bad()">\n![remote][pixel]\n[pixel]: https://evil.test/pixel\n```html\n<script>literal example</script>\n```';
  const markdown = (await restore(JSON.stringify(task))).pages[key].markdown;
  const [outside, fenced] = markdown.split('```html');
  assert.doesNotMatch(outside, /<img|onerror="bad\(\)">|!\[remote\]/);
  assert.match(fenced, /<script>literal example<\/script>/);
});
test('archive restoration supports existing captured BMP and icon images without allowing SVG payloads', async () => {
  const task = fixture(),
    key = task.queue[0].key;
  task.pages[key].text = '';
  task.pages[key].markdown = '';
  task.pages[key].html =
    '<img src="data:image/bmp;base64,Qk0AAAAAAA=="><img src="data:image/x-icon;base64,AAABAAAAAA=="><img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmJhZCgpPC9zY3JpcHQ+PC9zdmc+">';
  const restored = await restore(JSON.stringify(task));
  assert.equal(restored.queue[0].status, 'captured');
  assert.equal(restored.pages[key].diagnostics.images.embedded, 2);
  assert.doesNotMatch(restored.pages[key].html, /svg/);
});
test('archive directory bounds and an incorrect OpenAPI operation source are rejected', async () => {
  const task = fixture();
  task.queue = Array.from({ length: 5001 }, () => task.queue[0]);
  await assert.rejects(restore(JSON.stringify(task)), /5000/);
  const parsed = parseSpecification(
    '{"openapi":"3.0.3","info":{"title":"A","version":"1"},"paths":{"/a":{"get":{"responses":{"200":{"description":"OK"}}}}}}',
    { sourceURL: 'https://manual.test/docs/api.json' },
  );
  const archive = {
    schemaVersion: 2,
    sourceKind: 'openapi',
    taskId: specificationTaskId('a'.repeat(64), 'https://manual.test/docs/api.json', 'A', '1'),
    entry: 'https://manual.test/docs/api.json',
    product: 'A',
    version: '1',
    specVersion: parsed.specVersion,
    queue: parsed.queue,
    pages: parsed.pages,
  };
  assert.equal((await restore(JSON.stringify(archive))).queue[0].status, 'captured');
  archive.queue[0].url = 'https://evil.test/api.json#' + encodeURIComponent(archive.queue[0].key);
  await assert.rejects(restore(JSON.stringify(archive)), /范围/);
});
