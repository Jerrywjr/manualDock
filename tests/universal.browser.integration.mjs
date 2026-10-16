import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  tmp = await fs.mkdtemp(path.join(root, 'internal', 'security-manual-browser-'));
let context, panel, source, origin;
const errors = [],
  requests = [],
  extensionHashes = {};
let networkFault = false;
async function hashExtension(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name),
      key = prefix + entry.name;
    if (entry.isDirectory()) await hashExtension(file, key + '/');
    else if (entry.isFile())
      extensionHashes[key] = createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
  }
}
const started = Date.now();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  requests.push(u.pathname);
  if (networkFault && u.pathname === '/flaky/c.html') return req.socket.destroy();
  if (u.pathname === '/pixel.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
  }
  if (['/docs/spec.json', '/v3/api-docs'].includes(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Device API', version: '1.0' },
        paths: {
          '/objects': {
            get: { summary: 'Read objects', responses: { 200: { description: 'OK' } } },
          },
          '/policy': {
            post: {
              summary: 'Create policy',
              requestBody: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Policy' } },
                },
              },
              responses: { 201: { description: 'Created' } },
            },
          },
        },
        components: {
          schemas: { Policy: { type: 'object', properties: { name: { type: 'string' } } } },
        },
      }),
    );
  }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  const head = '<meta charset="utf-8"><title>Fixture manual</title><link rel="icon" href="data:,">';
  if (u.pathname === '/frames/shell.html')
    return res.end(
      `<!doctype html>${head}<iframe id="manual" src="/frames/a.html" style="width:100%;height:800px"></iframe>`,
    );
  if (u.pathname === '/cdocs.php')
    return res.end(
      `<!doctype html>${head}<ul class="x-tree-root-ct"><li class="x-tree-node"><div class="x-tree-node-el"><span>CLI commands</span></div><ul class="x-tree-node-ct">${[31, 32].map((id, i) => `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf ${i === 0 ? 'x-tree-selected' : ''}" ext:tree-node-id="api-menu-item${id}"><span>CLI Chapter ${i + 1}</span></div><ul class="x-tree-node-ct"></ul></li>`).join('')}</ul></li></ul><div id="articleContent"><h1>CLI Chapter 1</h1><pre>show interface</pre><p>Command help 1</p></div><script>document.querySelectorAll('.x-tree-node-leaf span').forEach((label,i)=>label.onclick=()=>{document.querySelectorAll('.x-tree-node-el').forEach(row=>row.classList.remove('x-tree-selected'));label.parentElement.classList.add('x-tree-selected');history.replaceState({},'', '/cdocs.php?index='+(i+1)+'&dataID=api-menu-item'+(31+i));setTimeout(()=>document.querySelector('#articleContent').innerHTML='<h1>CLI Chapter '+(i+1)+'</h1><pre>show interface '+(i+1)+'</pre><p>Command help '+(i+1)+'</p>',250);});</script>`,
    );
  if (u.pathname === '/console.html')
    return res.end(
      `<!doctype html>${head}<header><div class="console-main-menu"><a href="#/dashboard">Dashboard</a><a href="#/resources">Resources</a><a href="#/connectivity">Connectivity</a></div></header><button>Save</button><script>window.clicks=[];document.querySelector('.console-main-menu').onclick=e=>window.clicks.push(e.target.textContent);</script>`,
    );
  if (u.pathname === '/custom/index.html')
    return res.end(
      `<!doctype html>${head}<div id="custom-toc"><div role="tab" id="alpha" aria-selected="true">Alpha</div><div role="tab" id="beta" aria-selected="false">Beta</div><div role="tab" id="gamma" aria-selected="false">Gamma</div></div><section id="custom-body"><h1>Alpha</h1><p>Alpha content</p></section><script>document.querySelectorAll('[role=tab]').forEach(el=>el.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',String(x===el)));setTimeout(()=>document.querySelector('#custom-body').innerHTML='<h1>'+el.textContent+'</h1><p>'+el.textContent+' content</p>',250);});</script>`,
    );
  if (u.pathname === '/hash/index.html')
    return res.end(
      `<!doctype html>${head}<nav><a href="#/a">Hash A</a><a href="#/b">Hash B</a><a href="#/c">Hash C</a></nav><main></main><script>function render(){let h=location.hash||'#/a';document.querySelector('main').innerHTML='<h1>'+h+'</h1><p>Hash body '+h+'</p>';}window.onhashchange=render;render();</script>`,
    );
  const letter = u.pathname.split('/').at(-1).split('.')[0],
    prefix = u.pathname.startsWith('/frames/')
      ? '/frames/'
      : u.pathname.startsWith('/flaky/')
        ? '/flaky/'
        : '/docs/';
  return res.end(
    `<!doctype html>${head}<nav><a href="${prefix}a.html">Chapter A</a><a href="${prefix}b.html">Chapter B</a><a href="${prefix}c.html">Chapter C</a></nav><main><h1>Chapter ${letter}</h1><p>Body ${letter}</p><table><tr><th>Parameter</th></tr><tr><td>port-${letter}</td></tr></table><pre><code>GET /example/${letter}</code></pre><img src="/pixel.png"><button onclick="fetch('/dangerous')">执行请求</button><input value="CREDENTIAL_SECRET"></main>`,
  );
});
try {
  await fs.cp(
    process.env.SECURITY_MANUAL_EXTENSION_SOURCE || path.join(root, 'extension'),
    path.join(tmp, 'extension'),
    { recursive: true },
  );
  await hashExtension(path.join(tmp, 'extension'));
  await fs.mkdir(path.join(tmp, 'sentinel-extension'));
  await fs.writeFile(
    path.join(tmp, 'sentinel-extension/manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Storage isolation sentinel',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
    }),
  );
  await fs.writeFile(
    path.join(tmp, 'sentinel-extension/background.js'),
    'globalThis.sentinelReady = true;',
  );
  const manifest = JSON.parse(await fs.readFile(path.join(tmp, 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.host_permissions, undefined);
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(tmp, 'extension/manifest.json'), JSON.stringify(manifest));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    ...(process.env.MANUALDOCK_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE }
      : { channel: 'chromium' }),
    acceptDownloads: true,
    downloadsPath: tmp,
    viewport: { width: 1200, height: 1000 },
    args: [
      `--disable-extensions-except=${path.join(tmp, 'extension')},${path.join(tmp, 'sentinel-extension')}`,
      `--load-extension=${path.join(tmp, 'extension')},${path.join(tmp, 'sentinel-extension')}`,
    ],
  });
  if (context.serviceWorkers().length < 2) await context.waitForEvent('serviceworker');
  for (let i = 0; i < 100 && context.serviceWorkers().length < 2; i++)
    await new Promise((r) => setTimeout(r, 50));
  const identified = await Promise.all(
    context.serviceWorkers().map(async (worker) => ({
      worker,
      manifest: await worker.evaluate(() => chrome.runtime.getManifest()),
    })),
  );
  const worker = identified.find((x) => x.manifest.name === manifest.name).worker,
    sentinelWorker = identified.find(
      (x) => x.manifest.name === 'Storage isolation sentinel',
    ).worker,
    id = new URL(worker.url()).host;
  assert.notEqual(id, new URL(sentinelWorker.url()).host);
  await sentinelWorker.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('independent-extension-sentinel');
        r.onupgradeneeded = () => r.result.createObjectStore('proof');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
      }),
  );
  assert.ok(
    !(await worker.evaluate(() => indexedDB.databases())).some(
      (x) => x.name === 'independent-extension-sentinel',
    ),
  );
  source = await context.newPage();
  source.on('pageerror', (e) => errors.push('source:' + e.message));
  panel = await context.newPage();
  panel.on('pageerror', (e) => errors.push('panel:' + e.message));
  await source.goto(origin + '/docs/a.html');
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    source.url(),
  );
  async function open(purpose = 'document') {
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.locator(`[data-mode="${purpose === 'rotation' ? 'rotation' : 'web'}"]`).click();
    await panel.locator('#source-url').fill(source.url());
    await panel.locator('#source-connect').click();
    await panel.waitForFunction(
      (sourceId) =>
        document.querySelector('#source-connect-status').textContent.includes('已连接') &&
        !document.querySelector('#source-connect').disabled &&
        !document.querySelector('#source-select').disabled &&
        document.querySelector('#source-select').value === String(sourceId),
      tabId,
    );
    if (purpose === 'rotation') {
      assert.equal(await panel.locator('.app').getAttribute('data-current-mode'), 'rotation');
      assert.equal(await panel.locator('.batch-item').count(), 0);
      await panel.locator('#rotation-preset').waitFor({ state: 'visible' });
      return;
    }
    await panel.locator(`.batch-item[data-tab-id="${tabId}"] .batch-select`).click();
    await panel.waitForFunction(() => document.querySelector('.app').dataset.currentMode === 'web');
    await panel.locator('[data-operation=identify]').click();
    await panel.locator('#detect').click();
    await panel.waitForFunction(
      () =>
        !document.querySelector('#detect').disabled &&
        (document.querySelector('#profile-status').textContent.includes('识别') ||
          document.querySelector('#profile-status').textContent.includes('适配') ||
          document.querySelector('#error').textContent),
      null,
      { timeout: 45000 },
    );
  }
  async function run(expected = 3) {
    if (await panel.locator('#calibration-dialog').evaluate((d) => d.open))
      await panel.locator('[data-close-dialog]').click();
    await panel.locator('[data-operation=collect]').click();
    await panel.locator('#start').click();
    await panel.waitForFunction(
      (n) =>
        document.querySelector('#captured').textContent === String(n) &&
        !document.querySelector('#start').disabled,
      expected,
      { timeout: 120000 },
    );
    assert.equal(await panel.locator('#error').textContent(), '');
    console.log('run finished at ' + Math.round((Date.now() - started) / 1000) + 's');
  }
  async function archive() {
    const wait = panel.waitForEvent('download');
    await panel.locator('[data-export=json]').click();
    const file = await wait;
    const out = path.join(tmp, 'archive-' + Date.now() + '.json');
    await file.saveAs(out);
    return JSON.parse(await fs.readFile(out, 'utf8'));
  }
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: plain paths');
  await open();
  assert.equal(await panel.locator('#found').textContent(), '3');
  await run();
  const first = await archive();
  assert.equal(first.schemaVersion, 2);
  assert.equal(Object.keys(first.pages).length, 3);
  assert.match(Object.values(first.pages)[0].html, /data:image\/png/);
  assert.match(Object.values(first.pages)[0].markdown, /port-a/);
  assert.doesNotMatch(JSON.stringify(first), /CREDENTIAL_SECRET|onclick/);
  assert.ok(!requests.includes('/dangerous'));
  // Recognition must see the same saved entry, rather than a new chapter URL.
  await source.goto(first.profile.entry);
  await open();
  await panel.waitForFunction(() => !document.querySelector('#start').disabled);
  assert.equal(await panel.locator('#captured').textContent(), '3');
  const reopened = await archive();
  assert.equal(reopened.taskId, first.taskId);
  assert.deepEqual(reopened.pages, first.pages);
  await panel.screenshot({
    path: path.join(root, 'docs/test-universal-panel.png'),
    fullPage: true,
  });
  const offlineWait = panel.waitForEvent('download');
  await panel.locator('[data-export=html]').click();
  const offlineDownload = await offlineWait,
    offlinePath = path.join(tmp, 'offline.html');
  await offlineDownload.saveAs(offlinePath);
  const offline = await context.newPage(),
    offlineRequests = [];
  offline.on('request', (r) => {
    if (/^https?:/.test(r.url())) offlineRequests.push(r.url());
  });
  await offline.goto('file://' + offlinePath);
  await offline.waitForFunction(() =>
    [...document.images].every((i) => i.complete && i.naturalWidth > 0),
  );
  assert.equal(await offline.locator('main article').count(), 3);
  assert.equal(await offline.locator('table').count(), 3);
  assert.match(await offline.locator('body > main').textContent(), /GET \/example\/a/);
  assert.deepEqual(offlineRequests, []);
  await offline.close();
  // Hash route keeps all three identities rather than collapsing into one URL.
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: hash routes');
  await source.goto(origin + '/hash/index.html#/a');
  await open();
  await run();
  const hash = await archive();
  assert.equal(new Set(Object.values(hash.pages).map((p) => p.url)).size, 3);
  assert.ok(Object.values(hash.pages).every((p) => p.url.includes('#/')));
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: same-origin frame');
  await source.goto(origin + '/frames/shell.html');
  await open();
  await run();
  const framed = await archive();
  assert.equal(framed.profile.frameSelector, '#manual');
  assert.equal(Object.keys(framed.pages).length, 3);
  assert.equal(source.url(), origin + '/frames/shell.html');
  assert.ok(Object.values(framed.pages).every((p) => /\/frames\/[abc]\.html$/.test(p.url)));
  // A failed third chapter retries automatically after three minutes, retaining the first two pages.
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: automatic network recovery');
  await source.goto(origin + '/flaky/a.html');
  await panel.clock.install();
  await open();
  networkFault = true;
  await panel.locator('[data-operation=collect]').click();
  await panel.locator('#start').click();
  await panel.waitForFunction(
    () =>
      document.querySelector('#captured').textContent === '2' &&
      document.querySelector('#retry-status').textContent.includes('下次'),
    null,
    { timeout: 120000 },
  );
  const interrupted = await archive();
  assert.equal(Object.keys(interrupted.pages).length, 2);
  assert.ok(interrupted.queue.some((c) => c.status === 'failed'));
  const interruptedState = await panel.evaluate(
    async (id) => (await import('./task-store.js')).loadTask(id),
    interrupted.taskId,
  );
  assert.ok(interruptedState.queue.some((c) => c.status === 'failed' && c.recovery?.retryable));
  assert.equal(interruptedState.autoRecovery.attempts, 0);
  networkFault = false;
  await panel.clock.fastForward(180001);
  await panel.waitForFunction(
    () =>
      document.querySelector('#captured').textContent === '3' &&
      !document.querySelector('#start').disabled,
    null,
    { timeout: 120000 },
  );
  const recovered = await archive();
  const recoveredState = await panel.evaluate(
    async (id) => (await import('./task-store.js')).loadTask(id),
    recovered.taskId,
  );
  assert.equal(recoveredState.autoRecovery.attempts, 1);
  assert.equal(recoveredState.autoRecovery.enabled, false);
  for (const [key, page] of Object.entries(interrupted.pages))
    assert.deepEqual(recovered.pages[key], page, 'already saved chapters must stay unchanged');
  // User calibration works even when the directory and content lack common containers.
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: custom calibration');
  await source.goto(origin + '/custom/index.html');
  await open();
  await panel.locator('[data-operation=identify]').click();
  await panel.locator('#open-calibration').click();
  await panel.locator('#pick-toc').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('#custom-toc').click({ position: { x: 400, y: 5 } });
  await panel.waitForFunction(() => !document.querySelector('#pick-content').disabled);
  await panel.locator('#pick-content').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('#custom-body').click({ position: { x: 400, y: 5 } });
  await panel.waitForFunction(() => !document.querySelector('#sample-a').disabled);
  await panel.locator('#sample-a').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('#alpha').click();
  await panel.waitForFunction(() => !document.querySelector('#sample-b').disabled);
  assert.match(await source.locator('#custom-body').textContent(), /Alpha/);
  await panel.locator('#sample-b').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('#beta').click();
  await panel.waitForFunction(() => !document.querySelector('#verify').disabled);
  assert.match(
    await source.locator('#custom-body').textContent(),
    /Alpha/,
    'picker must not trigger the underlying navigation',
  );
  await panel.locator('#verify').click();
  await panel.waitForFunction(
    () => document.querySelector('#profile-status').textContent.includes('验证通过'),
    null,
    { timeout: 45000 },
  );
  await run();
  const custom = await archive();
  assert.equal(new Set(Object.values(custom.pages).map((p) => p.url)).size, 1);
  assert.equal(Object.keys(custom.pages).length, 3);
  // Local YAML and same-origin JSON use the same export controls; endpoint paths never requested.
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: specs');
  await panel.locator('[data-mode=spec]').click();
  await panel.locator('#spec-file').setInputFiles({
    name: 'api.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from(
      'openapi: 3.0.3\ninfo: {title: Local API, version: "2"}\npaths:\n  /objects:\n    get:\n      responses:\n        "200": {description: OK}\n',
    ),
  });
  await panel.waitForFunction(() =>
    document.querySelector('#spec-status').textContent.includes('1 个'),
  );
  const spec = await archive();
  assert.equal(spec.sourceKind, 'openapi');
  await panel.locator('[data-mode=web]').click();
  assert.equal(await panel.locator('#captured').textContent(), '3');
  assert.equal(await panel.locator('#start').isEnabled(), true);
  await panel.locator('[data-mode=spec]').click();
  await panel.locator('label[for=spec-remote-tab]').click();
  await panel.locator('#spec-url').fill(origin + '/v3/api-docs');
  await panel.locator('#fetch-spec').click();
  await panel.waitForFunction(() =>
    document.querySelector('#spec-status').textContent.includes('2 个'),
  );
  assert.ok(!requests.includes('/objects') && !requests.includes('/policy'));
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: CLI tree and manual samples');
  await source.goto(origin + '/cdocs.php?index=1&dataID=api-menu-item31');
  await open();
  assert.equal(await panel.locator('#found').textContent(), '2');
  await panel.locator('[data-operation=identify]').click();
  await panel.locator('#open-calibration').click();
  await panel.locator('#pick-toc').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('.x-tree-node-leaf span').nth(0).click();
  await panel.waitForFunction(() => !document.querySelector('#sample-a').disabled);
  await panel.locator('#sample-a').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('.x-tree-node-leaf span').nth(0).click();
  await panel.waitForFunction(() => !document.querySelector('#sample-b').disabled);
  await panel.locator('#sample-b').click();
  await source.locator('[data-security-picker]').first().waitFor();
  await source.locator('.x-tree-node-leaf span').nth(1).click();
  await panel.waitForFunction(() => !document.querySelector('#verify').disabled);
  assert.ok(source.url().includes('index=1'), 'picking must not navigate');
  await panel.locator('#verify').click();
  await panel.waitForFunction(
    () => document.querySelector('#profile-status').textContent.includes('验证通过'),
    null,
    { timeout: 45000 },
  );
  await run(2);
  const cli = await archive();
  assert.equal(cli.profile.adapterId, 'sangfor');
  assert.equal(cli.profile.pathPrefix, '/cdocs.php');
  assert.equal(Object.keys(cli.pages).length, 2);
  assert.ok(
    Object.values(cli.pages).every(
      (page) => page.text.includes('Command help') && page.navigationProof.verified,
    ),
  );
  // Select actual navigation controls, trial the sequence, save, then start/stop.
  console.log(Math.round((Date.now() - started) / 1000) + 's stage: rotation');
  await source.goto(origin + '/console.html');
  await open('rotation');
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 3);
  assert.deepEqual(
    await panel
      .locator('#rotation-targets li')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.firstChild.textContent.replace(/^\d+\.\s*/, '')),
      ),
    ['Dashboard', 'Resources', 'Connectivity'],
  );
  assert.deepEqual(await source.evaluate(() => window.clicks), []);
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(
    () => document.querySelector('#rotation-status').textContent.includes('试运行通过'),
    null,
    { timeout: 12000 },
  );
  assert.deepEqual(await source.evaluate(() => window.clicks), [
    'Dashboard',
    'Resources',
    'Connectivity',
  ]);
  await panel.locator('#rotation-interval').fill('120');
  await panel.locator('#rotation-interval').press('Tab');
  await panel.locator('#rotation-save').click();
  await panel.locator('#rotation-start').click();
  await panel.waitForFunction(() =>
    document.querySelector('#rotation-status').textContent.includes('已启动'),
  );
  await panel.locator('#rotation-stop').click();
  await panel.waitForFunction(() =>
    document.querySelector('#rotation-status').textContent.includes('已停止'),
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    extensionVersion: manifest.version,
    browserVersion: context.browser().version(),
    extensionHashes,
    fixtureOnly: true,
    isolatedProfile: true,
    independentExtensionIDsDistinct: true,
    independentExtensionStorageIsolated: true,
    realDeviceNotTested: true,
    plainPaths: 3,
    hashRoutes: 3,
    sameOriginFrameChapters: 3,
    calibratedSameURLChapters: 3,
    pickerDoesNotTriggerClicks: true,
    imagesTablesCodePreserved: true,
    offlineHTMLLoadsWithoutNetwork: true,
    reopenSavedPagesUnchanged: true,
    explicitDocumentConnections: true,
    explicitRecognition: true,
    rotationSourceExcludedFromDocuments: true,
    localYAML: true,
    sameOriginJSON: true,
    automaticNavigationDiscovery: true,
    navigationTrialAndStop: true,
    intervalChangeRetainsTrial: true,
    cliTreeChapters: 2,
    cliManualSamples: true,
    plainCaptureTiming: Object.values(first.pages).map((page) => page.diagnostics.timing),
    automaticNetworkRecovery: true,
    retryDelayMilliseconds: 180000,
    apiRequestsExecuted: 0,
    errors,
    testedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(root, 'docs/browser-test-universal.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(
    JSON.stringify({
      error: e.message,
      url: panel?.url(),
      panelError: await panel
        ?.locator('#error')
        .textContent()
        .catch(() => ''),
      status: await panel
        ?.locator('#status')
        .textContent()
        .catch(() => ''),
      profile: await panel
        ?.locator('#profile-status')
        .textContent()
        .catch(() => ''),
      errors,
      chapters: await panel
        ?.locator('#chapters')
        .textContent()
        .catch(() => ''),
      sourceBody: await source
        ?.locator('body')
        .textContent()
        .catch(() => ''),
    }),
  );
  await panel
    ?.screenshot({ path: path.join(root, 'docs/test-universal-failure.png'), fullPage: true })
    .catch(() => {});
  throw e;
} finally {
  await context?.close();
  if (server.listening) await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
}
