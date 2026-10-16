import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.TMPDIR = path.join(root, 'internal');
const temp = await fs.mkdtemp(path.join(root, 'internal/recognition-browser-'));
const started = Date.now();
const report = {
  passed: false,
  fixtureOnly: true,
  liveDevice: false,
  checks: [],
  errors: [],
  scans: [],
  sourceHashes: {},
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
report.scriptSha256 = sha(await fs.readFile(fileURLToPath(import.meta.url)));
let context, panel, deadline;
const fixture = { apiAmbiguous: false, postRequests: 0 };
const parameterNames = ['code', 'message', 'data', 'count', 'enabled', 'source', 'target'];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const family = url.pathname === '/cdocs.php' ? 'CLI' : 'API';
  const chapter = Number(url.searchParams.get('index') || 1);
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (request.method !== 'GET') {
    fixture.postRequests++;
    response.writeHead(405);
    response.end('The fixture only permits manual navigation');
    return;
  }
  if (family === 'API') {
    // The observed API shape is one navigation UL and four article treegrid DIVs.
    // The 1286 leaf labels below are synthetic, not a claim that all 1524 observed
    // navigation rows were leaves. A separate fixture retains five real UL roots.
    // POST is documentation text; these handlers never execute an API request.
    const multiRoots = url.searchParams.get('dataID') === 'fixture-multi-root';
    response.end(`<!doctype html><meta charset="utf-8"><title>API fixture</title><link rel="icon" href="data:,"><style>#api-navigation{width:270px;height:470px;overflow:auto}#api-navigation .x-tree-root-ct{max-height:450px;overflow:auto;width:260px}#articleContent{position:absolute;left:300px;top:20px;width:700px}.x-treegrid-ct{margin:8px 0}.x-treegrid-root-node .x-tree-node-el{display:flex;gap:12px}</style><div id="api-navigation" class="af-api-menutree x-border-layout-ct"><div class="af-api-menutree-scroll x-border-panel"><div id="api-navigation-inner"></div></div></div><div id="api-article" class="af-api-main-view"></div><script>
      const ambiguous = ${JSON.stringify(fixture.apiAmbiguous)};
      const multiRoots = ${JSON.stringify(multiRoots)};
      const parameterNames = ${JSON.stringify(parameterNames)};
      window.fixtureNavigation = { opened: [], renders: 0, articleTreeRenders: 0 };
      function recordBodyAction(target) {
        const actions = JSON.parse(sessionStorage.getItem('fixture-body-actions') || '[]');
        actions.push(target.closest('[data-body-control]')?.dataset.bodyControl || 'parameter-tree');
        sessionStorage.setItem('fixture-body-actions', JSON.stringify(actions));
      }
      function row(n, selected) {
        return '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf '+(selected === n ? 'x-tree-selected' : '')+'" leaf="true" ext:tree-node-id="api-menu-item'+n+'" data-chapter="'+n+'"><a class="x-tree-node-anchor" href="#"><span>POST chapter-'+n+'</span></a></div><ul class="x-tree-node-ct"></ul></li>';
      }
      function parameterGrid(index) {
        const rows = index === 3 ? parameterNames.map((name, i) => '<div class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf '+(i === 0 ? 'x-tree-selected' : '')+'" ext:tree-node-id="api-menu-item'+(90001+i)+'"><span class="x-tree-ec-icon" data-body-control="parameter-expand-'+name+'">+</span><a class="x-tree-node-anchor" href="#" data-body-control="parameter-'+name+'"><span>'+name+'</span></a><span>BODYFIELD'+name+' visible field description</span></div></div>').join('') : '';
        return '<div class="x-panel af-api-listviewgrid x-treegrid"><div class="x-panel-bwrap"><div class="x-panel-body x-panel-body-noheader"><div id="parameter-grid-'+index+'" class="x-tree-root-ct x-treegrid-ct x-tree-arrows"><div class="x-grid3-header">Parameter fields '+(index+1)+'</div><div class="x-treegrid-root-node">'+rows+'</div></div></div></div></div>';
      }
      function render(n) {
        const boundaries = multiRoots ? [0, 258, 515, 772, 1029, 1286] : [0, 1286];
        const roots = boundaries.slice(0, -1).map((start, index) => {
          const rows = Array.from({ length: boundaries[index + 1] - start }, (_, i) => row(start + i + 1, n)).join('') + (ambiguous && index === boundaries.length - 2 ? row(1286, n) : '');
          return '<ul id="sfext3-comp-api-tree-'+n+'-'+index+'" data-fixture-root="'+(index + 1)+'" class="x-tree-root-ct">'+rows+'</ul>';
        }).join('');
        document.querySelector('#api-navigation-inner').innerHTML = roots;
        const parameters = multiRoots ? '' : Array.from({length:4}, (_, index) => parameterGrid(index)).join('');
        const examples = '<details id="request-examples"><summary data-body-control="request-example-toggle">Request and response examples</summary><div hidden><pre>HIDDEN_REQUEST_EXAMPLE POST /documentation/chapter-'+n+'</pre><pre>HIDDEN_RESPONSE_EXAMPLE {"code":0}</pre><button type="button" data-body-control="request-submit">Send POST request</button></div></details>';
        document.querySelector('#api-article').innerHTML = '<section id="articleContent"><div id="sfext3-comp-api-body-'+n+'"><h1>POST chapter-'+n+'</h1><p>API_BODY_'+n+' distinct documentation text for chapter '+n+'.</p><pre>POST /documentation/chapter-'+n+'</pre>'+parameters+examples+'</div></section>';
        window.fixtureNavigation.renders++;
        if (!multiRoots) window.fixtureNavigation.articleTreeRenders++;
      }
      document.addEventListener('click', event => {
        if (event.target.closest('.af-api-listviewgrid,#request-examples')) {
          recordBodyAction(event.target);
          event.preventDefault();
          return;
        }
        const anchor = event.target.closest('#api-navigation a.x-tree-node-anchor'); if (!anchor) return;
        event.preventDefault();
        const n = Number(anchor.closest('[data-chapter]').dataset.chapter);
        window.fixtureNavigation.opened.push(n);
        history.replaceState(null, '', location.pathname + '?index=' + n + '&dataID=api-menu-item' + n);
        render(n);
      });
      render(${chapter});
    </script>`);
    return;
  }
  const rows = Array.from(
    { length: 447 },
    (_, i) =>
      `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf ${chapter === i + 1 ? 'x-tree-selected' : ''}" leaf="true" data-id="api-menu-item${i + 1}" data-chapter="${i + 1}"><span>show chapter-${i + 1}</span></div><ul class="x-tree-node-ct"></ul></li>`,
  ).join('');
  response.end(`<!doctype html><meta charset="utf-8"><title>CLI fixture</title><link rel="icon" href="data:,"><style>.x-tree-root-ct{height:450px;overflow:auto;width:240px}.af-api-body{position:absolute;left:300px;top:20px}</style><ul id="sfext3-comp-old-tree" class="x-tree-root-ct">${rows}</ul><div id="sfext3-comp-body-${chapter}" class="af-api-body"><h1>show chapter-${chapter}</h1><p>CLI_BODY_${chapter} distinct documentation text for chapter ${chapter}.</p><pre>show chapter-${chapter} details</pre></div><script>
    document.querySelector('.x-tree-root-ct').onclick = event => {
      const row = event.target.closest('[data-chapter]'); if (!row) return;
      document.querySelector('.x-tree-selected')?.classList.remove('x-tree-selected'); row.classList.add('x-tree-selected');
      const n = row.dataset.chapter;
      history.replaceState(null, '', location.pathname + '?index=' + n + '&dataID=api-menu-item' + n);
      document.querySelector('.af-api-body').outerHTML = '<div id="sfext3-comp-body-'+n+'" class="af-api-body"><h1>show chapter-'+n+'</h1><p>CLI_BODY_'+n+' distinct documentation text for chapter '+n+'.</p><pre>show chapter-'+n+' details</pre></div>';
    };
  </script>`);
});
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
try {
  const extension = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
  const hashes = async (dir, prefix = '') => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (item.isDirectory()) await hashes(path.join(dir, item.name), prefix + item.name + '/');
      else
        report.sourceHashes[prefix + item.name] = sha(await fs.readFile(path.join(dir, item.name)));
    }
  };
  await hashes(extension);
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  report.extensionVersion = manifest.version;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    headless: true,
    executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  deadline = setTimeout(() => void context.close(), Math.max(1, 120000 - (Date.now() - started)));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  panel = await context.newPage();
  panel.on('pageerror', (e) => report.errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const originals = await panel.evaluate(async (origin) => {
    const store = await import('./task-store.js');
    const { createTask } = await import('./engine.js');
    const { createBrowserIO } = await import('./browser-io.js');
    const old = [];
    for (const route of ['cdocs', 'adocs']) {
      const tab = await chrome.tabs.create({
        url: origin + '/' + route + '.php?index=1&dataID=api-menu-item1',
        active: false,
      });
      for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++)
        await new Promise((r) => setTimeout(r, 50));
      const io = createBrowserIO(tab.id),
        detected = await io.detect();
      const found = await io.discover(detected.profile, { expand: false });
      if (found.items.length !== (route === 'cdocs' ? 447 : 1286))
        throw new Error('Fixture must be readable before seeding historical rules');
      for (const suffix of route === 'cdocs' ? ['stale'] : ['a', 'b']) {
        const profile = { ...detected.profile, id: route + '-' + suffix };
        if (route === 'cdocs') {
          profile.tocSelector = '#sfext3-comp-old-tree';
          profile.contentSelector = '';
        }
        const task = createTask(profile, 'Archived ' + route, 'old');
        task.queue = found.items.map((chapter, i) => ({
          ...chapter,
          status: i ? 'pending' : 'captured',
        }));
        task.pages[task.queue[0].key] = {
          text: 'Original ' + profile.id,
          capturedAt: 'original',
          hash: 'original-hash',
        };
        task.updatedAt = '2020-01-01T00:00:00Z';
        await store.saveProfile(profile);
        await store.saveTask(task, task.queue[0].key);
        old.push(await store.loadTask(task.taskId));
      }
    }
    return old;
  }, origin);
  const connect = async (route) => {
    await panel
      .locator('#source-url')
      .fill(origin + '/' + route + '.php?index=1&dataID=api-menu-item1');
    await panel.locator('#source-connect').click();
    await panel.waitForFunction(
      (route) =>
        document.querySelector('#connection').textContent.includes('/' + route + '.php') &&
        !document.querySelector('#source-connect').disabled,
      route,
    );
    return Number(await panel.locator('#source-select').inputValue());
  };
  const progress = async (tabId) =>
    panel.evaluate(async (tabId) => {
      const list = (
        await chrome.runtime.sendMessage({ type: 'manualdock:runtime', action: 'list' })
      ).value;
      const source = list.find((item) => item.tabId === tabId);
      const store = await import('./task-store.js');
      return {
        source,
        task: source?.task?.taskId ? await store.loadTask(source.task.taskId) : null,
      };
    }, tabId);
  const wait = async (predicate, name, limit = 20000) => {
    const until = Date.now() + limit;
    while (Date.now() < until) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Timed out: ' + name);
  };
  const stopWorker = async () => {
    const cdp = await context.newCDPSession(panel);
    const versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => versions.push(...event.versions));
    await cdp.send('ServiceWorker.enable');
    await wait(
      async () =>
        versions.some((v) => v.scriptURL === worker.url() && v.runningStatus === 'running'),
      'active worker',
    );
    const version = versions.find(
      (v) => v.scriptURL === worker.url() && v.runningStatus === 'running',
    );
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await wait(
      async () =>
        versions.some((v) => v.versionId === version.versionId && v.runningStatus === 'stopped'),
      'worker termination',
    );
    await cdp.detach();
  };
  const multiRoot = await panel.evaluate(async (origin) => {
    const { createBrowserIO } = await import('./browser-io.js');
    const tab = await chrome.tabs.create({
      url: origin + '/adocs.php?index=1&dataID=fixture-multi-root',
      active: false,
    });
    try {
      for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const io = createBrowserIO(tab.id);
      const { profile } = await io.detect();
      const found = await io.discover(profile, { expand: false });
      const before = await io.current(profile);
      const verified = await io.verifySamples({
        ...profile,
        samples: [found.items[0], found.items.at(-1)],
      });
      const page = await io.capture(found.items.at(-1), profile);
      const after = await io.current(profile);
      const [shape] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => ({
          roots: document.querySelectorAll('#api-navigation ul.x-tree-root-ct').length,
          selected: document.querySelector('[data-fixture-root="5"] .x-tree-selected')?.dataset
            .chapter,
          opened: window.fixtureNavigation.opened,
        }),
      });
      return {
        count: found.items.length,
        before: before.chapter?.title,
        after: after.chapter?.title,
        verified: verified.verified,
        text: page.text,
        proof: page.navigationProof,
        shape: shape.result,
      };
    } finally {
      await chrome.tabs.remove(tab.id);
    }
  }, origin);
  check(
    'separate five-UL fixture scans all 1286 leaves and confirms navigation in its fifth root',
    multiRoot.count === 1286 &&
      multiRoot.before === 'POST chapter-1' &&
      multiRoot.after === 'POST chapter-1286' &&
      multiRoot.verified &&
      multiRoot.shape.roots === 5 &&
      multiRoot.shape.selected === '1286' &&
      multiRoot.shape.opened.includes(1) &&
      multiRoot.shape.opened.includes(1286) &&
      multiRoot.text.includes('API_BODY_1286') &&
      multiRoot.proof?.verified === true,
  );
  const cli = await connect('cdocs');
  await panel.locator('[data-operation="collect"]').click();
  check(
    'scan is enabled before selecting any historical CLI configuration',
    await panel.locator('#scan').isEnabled(),
  );
  let scanStart = Date.now();
  await panel.locator('#scan').click();
  await wait(
    async () =>
      (await progress(cli)).task?.queue.length === 447 &&
      (await panel.locator('#scan').isEnabled()),
    'CLI directory',
  );
  report.scans.push({ source: 'CLI', chapters: 447, elapsedMs: Date.now() - scanStart });
  const cliTask = (await progress(cli)).task;
  check(
    'CLI detection uses the stable body and creates a task separate from the stale archive',
    cliTask.profile.contentSelector === '.af-api-body' &&
      !originals.some((t) => t.taskId === cliTask.taskId),
  );
  await panel.locator('#capture-current').click();
  await wait(
    async () =>
      Object.keys((await progress(cli)).task?.pages || {}).length > 0 &&
      !(await progress(cli)).source.busy,
    'CLI capture',
  );
  check(
    'CLI current chapter is saved through the actual UI',
    Object.values((await progress(cli)).task.pages).some((page) =>
      page.text.includes('CLI_BODY_1'),
    ),
  );
  const api = await connect('adocs');
  scanStart = Date.now();
  await panel.locator('#detect').click();
  await wait(
    async () =>
      (await progress(api)).task?.queue.length === 1286 &&
      (await panel.locator('#detect').isEnabled()),
    'API directory',
  );
  report.scans.push({ source: 'API', chapters: 1286, elapsedMs: Date.now() - scanStart });
  const apiTask = (await progress(api)).task;
  check(
    'duplicate API configurations do not block a fresh 1286-chapter task',
    !originals.some((t) => t.taskId === apiTask.taskId),
  );
  const apiSource = context.pages().find((page) => page.url().includes('/adocs.php'));
  const checkApiShape = async (stage) => {
    const shape = await apiSource.evaluate(() => {
      const directory = document.querySelector('#api-navigation ul.x-tree-root-ct');
      const grids = [...document.querySelectorAll('#articleContent div.x-tree-root-ct')];
      return {
        totalRoots: document.querySelectorAll('.x-tree-root-ct').length,
        directoryRoots: document.querySelectorAll('#api-navigation ul.x-tree-root-ct').length,
        directoryAncestors:
          directory?.parentElement?.tagName === 'DIV' &&
          directory.parentElement.parentElement.matches('.af-api-menutree-scroll.x-border-panel') &&
          directory.parentElement.parentElement.parentElement.matches(
            '.af-api-menutree.x-border-layout-ct',
          ),
        gridRows: grids.map((grid) => grid.querySelectorAll('.x-tree-node-el').length),
        gridStructure: grids.every(
          (grid) =>
            grid.matches('.x-treegrid-ct.x-tree-arrows') &&
            grid.children.length === 2 &&
            grid.children[0].matches('div.x-grid3-header') &&
            grid.children[1].matches('div.x-treegrid-root-node') &&
            grid.parentElement.matches('.x-panel-body.x-panel-body-noheader') &&
            grid.parentElement.parentElement.matches('.x-panel-bwrap') &&
            grid.parentElement.parentElement.parentElement.matches(
              '.x-panel.af-api-listviewgrid.x-treegrid',
            ),
        ),
      };
    });
    assert.deepEqual(shape.gridRows, [0, 0, 0, 7]);
    check(
      'observed one-directory/four-grid structure remains stable: ' + stage,
      shape.totalRoots === 5 &&
        shape.directoryRoots === 1 &&
        shape.directoryAncestors &&
        shape.gridStructure,
    );
  };
  await checkApiShape('initial scan');

  check(
    'API discovers 1286 navigation leaves beside four parameter grids in its own article region',
    apiTask.profile.contentSelector === '#articleContent' &&
      (await apiSource.locator('#api-navigation ul.x-tree-root-ct').count()) === 1 &&
      (await apiSource.locator('#api-navigation a.x-tree-node-anchor').count()) === 1286 &&
      (await apiSource.locator('.af-api-body').count()) === 0,
  );
  await apiSource.locator('[data-chapter="7"] a').click();
  const staleRegions = await apiSource.evaluate(() => ({
    tocSelector: '.x-tree-root-ct',
    contentSelector: '#' + document.querySelector('#articleContent > div').id,
  }));
  const oldRootIds = await apiSource
    .locator('#api-navigation ul.x-tree-root-ct')
    .evaluateAll((roots) => roots.map((root) => root.id));
  await apiSource.locator('[data-chapter="8"] a').click();
  check(
    'API rebuilds its navigation and four parameter grids when navigating past chapter seven',
    (await apiSource.locator('#api-navigation ul.x-tree-root-ct').count()) === 1 &&
      (await apiSource.locator(staleRegions.tocSelector).count()) === 5 &&
      (await apiSource.locator('#articleContent div.x-tree-root-ct.x-treegrid-ct').count()) === 4 &&
      (await apiSource.evaluate(
        (ids) => ids.every((id) => !document.getElementById(id)),
        oldRootIds,
      )) &&
      (await apiSource.locator(staleRegions.contentSelector).count()) === 0 &&
      (await apiSource.locator('#articleContent').textContent()).includes('API_BODY_8'),
  );
  await checkApiShape('chapter eight');
  const stableDirectory = await panel.evaluate(async (tabId) => {
    const { createBrowserIO } = await import('./browser-io.js');
    const io = createBrowserIO(tabId);
    const { profile } = await io.detect();
    const found = await io.discover(profile, { expand: false });
    const current = await io.current(profile);
    return {
      items: found.items.map(({ key, title }) => ({ key, title })),
      current: current.chapter,
      status: current.status,
      diagnostics: found.diagnostics,
    };
  }, api);
  assert.deepEqual(
    stableDirectory.items,
    apiTask.queue.map(({ key, title }) => ({ key, title })),
  );
  check(
    'directory rescan and selected-chapter confirmation ignore the rebuilt parameter grids',
    stableDirectory.status === 'ok' &&
      stableDirectory.current?.title === 'POST chapter-8' &&
      !stableDirectory.diagnostics?.ambiguousPaths,
  );
  // Seed the saved state of an older, already validated task. The seven bodies
  // are explicit historical fixture records, not newly collected live evidence.
  const staleTask = await panel.evaluate(
    async ({ taskId, tabId, staleRegions }) => {
      const store = await import('./task-store.js');
      const { ruleSignature, cleanChapter } = await import('./profiles.js');
      const task = await store.loadTask(taskId);
      task.profile = { ...task.profile, ...staleRegions };
      task.profile.samples = task.queue
        .slice(0, 2)
        .map((chapter) => cleanChapter(chapter, task.profile));
      task.validation = { signature: ruleSignature(task.profile), verifiedAt: 'original' };
      task.status = 'paused';
      task.autoRecovery = { enabled: false, nextAttemptAt: null, sourceTabId: tabId };
      task.pages = {};
      const failure = {
        reason: 'calibration',
        retryable: false,
        scope: 'task',
        message: '目录定位匹配多个普通区域；目录选中未确认，请重新校准',
      };
      task.recovery = failure;
      for (const [index, chapter] of task.queue.entries()) {
        chapter.status = index < 7 ? 'captured' : index === 7 ? 'failed' : 'pending';
        if (index < 7)
          task.pages[chapter.key] = {
            text: 'Saved API_BODY_' + (index + 1),
            html: '<p>Original API chapter ' + (index + 1) + '</p>',
            capturedAt: 'original-' + (index + 1),
            hash: 'original-hash-' + (index + 1),
          };
        if (index === 7) {
          chapter.error = failure.message;
          chapter.recovery = { ...failure };
        }
      }
      await store.saveProfile(task.profile);
      await store.saveWholeTask(task);
      const result = await chrome.runtime.sendMessage({
        type: 'manualdock:runtime',
        action: 'adopt',
        tabId,
        args: [task, task.profile],
      });
      if (result.error) throw new Error(result.error);
      return store.loadTask(taskId);
    },
    { taskId: apiTask.taskId, tabId: api, staleRegions },
  );
  assert.equal(Object.keys(staleTask.pages).length, 7);
  const interruptedKey = staleTask.queue[7].key;
  // Reopen the upgraded extension against the saved task. Reloading just the
  // panel would leave its initialized background session alive and skip binding
  // recovery; stop the worker as well to exercise the stale rule at chapter 8.
  await stopWorker();
  await panel.reload();
  await wait(async () => {
    const value = await progress(api);
    return value.source?.initialized && value.source.task?.taskId === staleTask.taskId;
  }, 'restored stale API task at chapter eight');
  await panel.waitForFunction(
    ({ tabId, tocSelector, contentSelector }) =>
      document.querySelector('#source-select').value === String(tabId) &&
      document.querySelector('#connection').textContent.includes('/adocs.php') &&
      document.querySelector('#toc-selector').value === tocSelector &&
      document.querySelector('#content-selector').value === contentSelector &&
      !document.querySelector('#source-connect').disabled &&
      !document.querySelector('#detect').disabled,
    { tabId: api, ...staleRegions },
  );
  check(
    'worker and panel restoration bind the original API task at chapter eight without rewriting its rules',
    new URL(apiSource.url()).searchParams.get('index') === '8' &&
      (await apiSource.locator('#api-navigation ul.x-tree-root-ct').count()) === 1,
  );
  await checkApiShape('worker restores chapter eight');
  const restoredStaleTask = (await progress(api)).task;
  assert.deepEqual(restoredStaleTask.profile, staleTask.profile);
  assert.deepEqual(restoredStaleTask.queue, staleTask.queue);
  assert.deepEqual(restoredStaleTask.pages, staleTask.pages);
  await panel.locator('[data-operation="collect"]').click();
  // Ambiguity at the end of the navigation must invalidate the whole queue
  // before the interrupted chapter or its next pending neighbor is consumed.
  fixture.apiAmbiguous = true;
  await apiSource.reload();
  await panel.locator('#start').click();
  await wait(async () => {
    const value = await progress(api);
    return (
      !value.source.busy &&
      Boolean(value.source.error) &&
      (await panel.locator('#start').isEnabled())
    );
  }, 'ambiguous API repair');
  const ambiguousTask = (await progress(api)).task;
  assert.deepEqual(ambiguousTask.queue, staleTask.queue);
  assert.deepEqual(ambiguousTask.pages, staleTask.pages);
  assert.deepEqual(ambiguousTask.profile, staleTask.profile);
  assert.equal(ambiguousTask.taskId, apiTask.taskId);
  check(
    'ambiguous final API chapter keeps the original queue, profile and seven saved bodies',
    true,
  );
  check(
    'ambiguous API repair does not consume the failed or next pending chapter',
    ambiguousTask.queue[7].status === 'failed' && ambiguousTask.queue[8].status === 'pending',
  );
  fixture.apiAmbiguous = false;
  await apiSource.goto(apiTask.profile.entry);
  await panel.locator('#start').click();
  await wait(
    async () => {
      const value = await progress(api);
      return (
        value.task.queue.find((chapter) => chapter.key === interruptedKey)?.status === 'captured'
      );
    },
    'stale API task recovery',
    30000,
  );
  await panel.locator('#pause').click();
  await wait(async () => !(await progress(api)).source.busy, 'repaired API pause');
  const repairedTask = (await progress(api)).task;
  assert.equal(repairedTask.taskId, apiTask.taskId);
  assert.deepEqual(
    repairedTask.queue.map((chapter) => chapter.key),
    staleTask.queue.map((chapter) => chapter.key),
  );
  for (const [key, value] of Object.entries(staleTask.pages))
    assert.deepEqual(repairedTask.pages[key], value);
  check(
    'Continue repairs old API bindings within the same task and preserves all seven saved bodies',
    true,
  );
  check(
    'Continue retries failed API chapter eight after validating navigation samples',
    repairedTask.pages[interruptedKey].text.includes('API_BODY_8') &&
      repairedTask.validation?.verifiedAt !== 'original' &&
      repairedTask.validation?.signature !== staleTask.validation.signature &&
      repairedTask.profile.tocSelector !== '.x-tree-root-ct' &&
      repairedTask.profile.contentSelector === '#articleContent',
  );
  await checkApiShape('continued collection');
  const navigation = await apiSource.evaluate(() => window.fixtureNavigation);
  check(
    'API sample and capture navigation survives repeated tree and body replacement',
    navigation.opened.includes(1) &&
      navigation.opened.includes(2) &&
      navigation.opened.includes(8) &&
      navigation.renders >= 4 &&
      navigation.articleTreeRenders >= 3,
  );
  const navigationScope = await apiSource.evaluate((selector) => {
    const matches = [...document.querySelectorAll(selector)];
    const navigation = document.querySelector('#api-navigation');
    const article = document.querySelector('#articleContent');
    return {
      count: matches.length,
      leftOnly: matches.every((match) => navigation === match || navigation.contains(match)),
      includesArticle: matches.some((match) => match.contains(article) || article.contains(match)),
    };
  }, repairedTask.profile.tocSelector);
  check(
    'legacy global selector migrates to the left navigation while body parameter trees are present',
    navigationScope.count > 0 && navigationScope.leftOnly && !navigationScope.includesArticle,
  );
  check(
    'body parameter fields and request examples never enter the saved chapter queue',
    repairedTask.queue.length === 1286 &&
      repairedTask.queue.every((chapter, index) => chapter.title === 'POST chapter-' + (index + 1)),
  );
  const finalChapter = repairedTask.queue.at(-1);
  assert.equal(finalChapter.title, 'POST chapter-1286');
  await apiSource.locator('#api-navigation [data-chapter="1286"] a').click();
  await panel.locator('#capture-current').click();
  await wait(async () => {
    const value = await progress(api);
    return !value.source.busy && value.task.queue.at(-1)?.status === 'captured';
  }, 'API final navigation chapter');
  const finalPage = (await progress(api)).task.pages[finalChapter.key];
  check(
    'the actual UI saves navigation chapter 1286 with verified navigation proof beside body grids',
    finalPage.text.includes('API_BODY_1286') &&
      finalPage.navigationProof?.verified === true &&
      (await apiSource.locator('#api-navigation ul.x-tree-root-ct').count()) === 1 &&
      (await apiSource.locator('#api-navigation .x-tree-selected').count()) === 1,
  );
  await checkApiShape('chapter 1286');
  const parameterExports = await panel.evaluate(
    async ({ taskId, keys, markers }) => {
      const { loadTask } = await import('./task-store.js');
      const { buildExports } = await import('./core.js');
      const task = await loadTask(taskId);
      const exported = buildExports(task);
      const archive = JSON.parse(exported.json);
      return {
        missingFields: Object.fromEntries(
          keys.map((key) => [
            key,
            Object.fromEntries(
              ['text', 'markdown', 'html'].map((field) => [
                field,
                markers.filter((marker) => !task.pages[key]?.[field]?.includes(marker)),
              ]),
            ),
          ]),
        ),
        pagesComplete: keys.every((key) =>
          ['text', 'markdown', 'html'].every((field) =>
            markers.every((marker) => task.pages[key]?.[field]?.includes(marker)),
          ),
        ),
        archiveComplete: keys.every((key) =>
          ['text', 'markdown', 'html'].every((field) =>
            markers.every((marker) => archive.pages[key]?.[field]?.includes(marker)),
          ),
        ),
        markdownComplete: markers.every((marker) => exported.markdown.includes(marker)),
        htmlComplete: markers.every((marker) => exported.html.includes(marker)),
        hiddenExamplesCaptured: keys.some((key) =>
          /HIDDEN_REQUEST_EXAMPLE|HIDDEN_RESPONSE_EXAMPLE/.test(task.pages[key]?.text || ''),
        ),
      };
    },
    {
      taskId: apiTask.taskId,
      keys: [interruptedKey, finalChapter.key],
      markers: parameterNames.map((name) => 'BODYFIELD' + name),
    },
  );
  report.parameterExports = parameterExports;
  check(
    'captured chapters eight and 1286 retain all seven visible parameter rows in text, Markdown and HTML',
    parameterExports.pagesComplete,
  );
  check(
    'JSON, Markdown and HTML exports retain the visible parameter rows',
    parameterExports.archiveComplete &&
      parameterExports.markdownComplete &&
      parameterExports.htmlComplete,
  );
  report.articleExamples = {
    hiddenExamplesCaptured: parameterExports.hiddenExamplesCaptured,
    expansionAttempted: false,
    limitation: 'Hidden examples are tracked separately from the visible parameter-row assertions.',
  };
  assert.deepEqual(
    await apiSource.evaluate(() =>
      JSON.parse(sessionStorage.getItem('fixture-body-actions') || '[]'),
    ),
    [],
  );
  check(
    'chapter eight and 1286 collection never click or expand article parameter or request trees',
    true,
  );
  check(
    'POST-labelled API chapters only navigate documentation and never issue POST requests',
    fixture.postRequests === 0,
  );
  // Let navigation preflight samples finish, then fault the next
  // queued chapter by actually moving outside the calibrated query scope.
  await apiSource.evaluate(() => {
    document.addEventListener('click', (event) => {
      const row = event.target.closest('[data-chapter]');
      if (row && ![1, 2, 1286].includes(Number(row.dataset.chapter)))
        history.replaceState(null, '', location.pathname + '?unapproved=1');
    });
  });
  const savedBeforeFailure = (await progress(api)).task.pages;
  await panel.locator('#start').click();
  await wait(async () => {
    const value = await progress(api);
    return !value.source.busy && value.task.queue.some((c) => c.status === 'failed');
  }, 'API scope failure');
  await panel.waitForFunction(
    () =>
      !document.querySelector('#collection-message').hidden &&
      !document.querySelector('#start').disabled,
  );
  check(
    'scope failure is explained beside Continue without opening an error tab',
    (await panel.locator('#collection-message').textContent()).includes('离开手册范围'),
  );
  await panel.locator('#collection-message').click();
  check(
    'the pause message opens complete details in the preview area',
    (await panel.locator('[data-view-panel="errors"]').isVisible()) &&
      (await panel.locator('#error-log').textContent()).includes('离开手册范围'),
  );
  const firstFailure = (await progress(api)).task;
  await panel.locator('#start').click();
  await wait(
    async () => !(await progress(api)).source.busy && (await panel.locator('#start').isEnabled()),
    'failed API recovery',
  );
  assert.deepEqual((await progress(api)).task.queue, firstFailure.queue);
  check('continuing before source recovery does not consume another chapter', true);
  await panel.screenshot({ path: path.join(root, 'internal/scoped-navigation-pause.png') });
  await apiSource.goto(apiTask.profile.entry);
  await panel.locator('#start').click();
  const failedKey = firstFailure.queue.find((c) => c.status === 'failed').key;
  await wait(
    async () =>
      (await progress(api)).task.queue.find((c) => c.key === failedKey)?.status === 'captured',
    'recovered API chapter',
  );
  await panel.locator('#pause').click();
  await wait(async () => !(await progress(api)).source.busy, 'recovered API pause');
  const afterRecovery = (await progress(api)).task;
  for (const [key, value] of Object.entries(savedBeforeFailure))
    assert.deepEqual(afterRecovery.pages[key], value);
  check('source recovery retries the interrupted chapter and keeps earlier saved content', true);
  check(
    'successful recovery clears the persistent failure message',
    await panel.locator('#collection-message').isHidden(),
  );
  await panel.locator('#source-select').selectOption(String(cli));
  await panel.waitForFunction(() => !document.querySelector('#detect').disabled);
  const source = context.pages().find((page) => page.url().includes('/cdocs.php'));
  await source.locator('[data-chapter="2"]').click();
  await panel.locator('[data-operation="identify"]').click();
  await panel.locator('#detect').click();
  await wait(
    async () => !(await progress(cli)).source.busy && (await panel.locator('#detect').isEnabled()),
    'CLI re-detection',
  );
  check(
    're-detection on a different known CLI chapter reuses the same task',
    (await progress(cli)).task.taskId === cliTask.taskId,
  );
  const beforeRestart = await progress(cli);
  await stopWorker();
  await panel.reload();
  await wait(async () => (await progress(cli)).source?.initialized, 'restored CLI task');
  // Backend readiness precedes the panel's sequential source restoration.
  // Wait until the final source is selected before interacting with the picker.
  await panel.waitForFunction(
    () =>
      document.querySelector('#connection').textContent.includes('/adocs.php') &&
      document.querySelector('#source-select').options.length === 3 &&
      !document.querySelector('#source-connect').disabled,
  );
  const restored = await progress(cli);
  check(
    'actual worker restart and panel reload keep the CLI task after changing chapters',
    restored.task.taskId === cliTask.taskId,
  );
  assert.deepEqual(restored.task.pages, beforeRestart.task.pages);
  check('worker restart preserves already saved CLI content', true);
  const restoredApi = (await progress(api)).task;
  check(
    'paused API task is restored with one directory and four body grids despite historical duplicates',
    restoredApi.taskId === apiTask.taskId &&
      (await apiSource.locator('#api-navigation ul.x-tree-root-ct').count()) === 1,
  );
  await checkApiShape('final worker restart');
  assert.deepEqual(restoredApi.pages[finalChapter.key], finalPage);
  check('worker restart preserves the final chapter body and its navigation proof', true);
  assert.deepEqual(
    await apiSource.evaluate(() =>
      JSON.parse(sessionStorage.getItem('fixture-body-actions') || '[]'),
    ),
    [],
  );
  check(
    'all resumes and worker restorations leave article parameter and request controls untouched',
    true,
  );
  await panel.locator('[data-mode="web"]').click();
  await panel.locator('#source-select').selectOption(String(cli));
  await panel.waitForFunction(
    () =>
      document.querySelector('#connection').textContent.includes('/cdocs.php') &&
      !document.querySelector('#detect').disabled,
  );
  await panel.locator('[data-operation="identify"]').click();
  const oldAfter = await panel.evaluate(
    async (ids) => {
      const store = await import('./task-store.js');
      return Promise.all(ids.map((id) => store.loadTask(id)));
    },
    originals.map((task) => task.taskId),
  );
  assert.deepEqual(oldAfter, originals);
  check('all three historical archives retain their original metadata and saved bodies', true);
  check(
    'no purpose or historical configuration chooser remains',
    (await panel.locator('#profile-list, #source-purpose').count()) === 0,
  );
  await panel.screenshot({ path: path.join(root, 'internal/scoped-navigation-legacy.png') });
  assert.deepEqual(report.errors, []);
  check('no panel JavaScript errors', true);
  report.passed = true;
} catch (error) {
  report.error = error.message;
  report.uiAtFailure = await panel
    ?.evaluate(() =>
      Object.fromEntries(
        [
          'connection',
          'source-connect-status',
          'source-select',
          'toc-selector',
          'content-selector',
          'profile-list',
          'error',
          'recognition-message',
          'status',
          'detect',
        ].map((id) => {
          const el = document.getElementById(id);
          return [
            id,
            { text: el?.textContent, value: el?.value, disabled: el?.disabled, hidden: el?.hidden },
          ];
        }),
      ),
    )
    .catch(() => null);
  report.stack = error.stack;
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
  report.temporaryFilesRemoved = true;
  report.elapsedMs = Date.now() - started;
  await fs.writeFile(
    path.join(root, 'docs/browser-test-recognition.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ ...report, sourceHashes: undefined }, null, 2));
}
