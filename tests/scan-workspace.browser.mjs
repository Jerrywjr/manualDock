import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const internal = path.join(root, 'internal');
await fs.mkdir(internal, { recursive: true });
process.env.TMPDIR = internal;
const sourceExtension = await fs.realpath(
  process.env.MANUALDOCK_EXTENSION_SOURCE || path.join(root, 'extension'),
);
assert.ok(
  sourceExtension.startsWith(root + path.sep),
  'fixture source must remain in this repository',
);
const reportName = process.env.MANUALDOCK_SCAN_REPORT || 'browser-test-scan-workspace.json';
assert.equal(path.basename(reportName), reportName, 'report must remain in docs');
const started = Date.now();
const temporary = await fs.mkdtemp(path.join(internal, 'scan-workspace-browser-'));
const fixtureExtension = path.join(temporary, 'extension');
let context, panel, worker, deadline, childrenResponse;
const sourceErrors = [];
const requestLog = [];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const report = {
  passed: false,
  fixtureOnly: true,
  realDeviceNotTested: true,
  isolatedProfile: true,
  executionLimitMs: 120000,
  extraFixturePermission: 'http://127.0.0.1/*',
  fixtureSetup:
    'The deleted 447-chapter task and retained profiles are seeded with production IO/store modules; deletion, new recognition and capture use actual UI controls.',
  largeDirectoryFixture: '447 generic links on an adocs.php route; this is not target device DOM',
  entryRoutingFixture:
    'URL entry uses actual controls without selecting document. Initial entry uses the actual panel tab parameter. Toolbar handoff calls the original production action listener exposed by a fixture-only registration wrapper; no physical browser toolbar click is claimed.',
  bulkReadinessFixture:
    'Two local sources: only the two-chapter prepared manual is captured; the unknown page remains unscanned until explicitly requested. Its later recognition failure appears only on its own row and calibration view.',
  runningRotationTrialFixture:
    'A synthetic framework.php page records three safe hash-navigation clicks. The first trial delays the returned browser startup response by 4.5 seconds while the source remains free to execute. It must complete exactly one pass. The UI then verifies an actual 30-second normal rotation click and retrials; no real device is involved.',
  manualCalibrationFixture:
    'Unknown local pages contain only plain div regions with non-semantic IDs. Detection is allowed to fail naturally. Directory/body selection uses the production page picker through actual UI clicks; no profile or failure result is injected.',
  lazyFixture:
    'The local children HTTP response is held until B has been connected and scanned; no production timer or source-session method is patched.',
  sourceHashes: {},
  scriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
  checks: [],
  stages: [],
  errors: sourceErrors,
};
function stage(name) {
  report.stages.push({ name, elapsedMs: Date.now() - started });
  console.log(`scan workspace: ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
}
function check(name, actual, expected) {
  const item = { name, actual, expected, passed: false };
  report.checks.push(item);
  assert.deepEqual(actual, expected, name);
  item.passed = true;
}
const link = (url, title) => `<a href="${url}">${title}</a>`;
const html = (title, directory, body, script = '') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"><nav id="directory" aria-label="Manual directory">${directory}</nav><main id="article"><h1>${title}</h1><p>${body}</p><pre>${body} command example</pre></main>${script ? `<script>${script}</script>` : ''}`;
const lazyChildren = ['3', '4']
  .map((n) => link('/lazy-a/chapter-' + n + '.html', 'A lazy chapter ' + n))
  .join('');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requestLog.push({ path: url.pathname, query: url.search, at: Date.now() - started });
  if (url.pathname === '/lazy-a/children') {
    childrenResponse = response;
    return;
  }
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/bulk-ready/')) {
    const chapter = url.pathname.includes('two') ? 'two' : 'one';
    response.end(
      html(
        'Prepared chapter ' + chapter,
        ['one', 'two']
          .map((part) => link('/bulk-ready/' + part + '.html', 'Prepared chapter ' + part))
          .join(''),
        'BULK_READY_' +
          chapter +
          ': This chapter contains distinct local documentation for checking prepared-source collection.',
      ),
    );
    return;
  }
  if (url.pathname === '/bulk-unknown.php') {
    response.end(
      '<!doctype html><title>Unrecognized source</title><p>This page has no manual directory.</p>',
    );
    return;
  }
  if (url.pathname.startsWith('/lazy-a/')) {
    response.end(
      html(
        'Fixture A manual',
        link('/lazy-a/chapter-1.html', 'A initial chapter 1') +
          link('/lazy-a/chapter-2.html', 'A initial chapter 2') +
          '<button id="expand-a" aria-expanded="false" aria-controls="lazy-children">More A chapters</button><div id="lazy-children"></div>',
        'SOURCE_A_ONLY directory content',
        `window.fixtureRequestedAt=0;window.fixtureLoadedAt=0;document.querySelector('#expand-a').onclick=async function(){this.setAttribute('aria-expanded','true');window.fixtureRequestedAt=Date.now();const response=await fetch('/lazy-a/children');document.querySelector('#lazy-children').innerHTML=await response.text();window.fixtureLoadedAt=Date.now();};`,
      ),
    );
    return;
  }
  if (url.pathname.startsWith('/docs-b/')) {
    response.end(
      html(
        'Fixture B manual',
        [1, 2].map((n) => link('/docs-b/chapter-' + n + '.html', 'B chapter ' + n)).join(''),
        'SOURCE_B_ONLY directory content',
      ),
    );
    return;
  }
  if (/^\/opaque(?:-fresh)?\.php$/.test(url.pathname)) {
    const chapter = url.searchParams.get('chapter') === '2' ? 2 : 1;
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Opaque fixture chapter ${chapter}</title><link rel="icon" href="data:,"><style>body{font:16px system-ui;margin:48px}#x7{padding:24px;min-height:100px;border:1px solid #888}#x7 a{display:block;margin:8px}#x9{margin-top:24px;padding:24px;min-height:160px;border:1px solid #888}</style><div id="x7">${[1, 2].map((n) => link(url.pathname + '?chapter=' + n, 'Opaque chapter ' + n)).join('')}</div><div id="x9"><h1>Opaque chapter ${chapter}</h1><p>MANUAL_PICK_CHAPTER_${chapter}. This local chapter has distinct documentation text for manual calibration and capture verification.</p><pre>show local-fixture-${chapter}</pre></div>`,
    );
    return;
  }
  if (url.pathname === '/framework.php') {
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Fixture framework console</title><link rel="icon" href="data:,"><header><nav id="primary-navigation" aria-label="Main navigation"><a href="#/dashboard">Dashboard</a><a href="#/resources">Resources</a><a href="#/connectivity">Connectivity</a></nav></header><main><h1>Framework console fixture</h1></main><script>window.fixtureMenuClicks=[];document.querySelector("#primary-navigation").onclick=(event)=>{if(event.target.matches("a"))window.fixtureMenuClicks.push(event.target.textContent);};</script>',
    );
    return;
  }
  if (url.pathname === '/console') {
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Fixture management console</title><link rel="icon" href="data:,"><nav><button>System</button><button>Network</button></nav><main><h1>Management console</h1><p>LOCAL_MANAGEMENT_ONLY</p></main>',
    );
    return;
  }
  if (url.pathname === '/adocs.php') {
    const chapter = Number((url.searchParams.get('dataID') || '').replace('api-', '')) || 1;
    const rows = Array.from({ length: 447 }, (_, i) =>
      link('/adocs.php?index=0&dataID=api-' + (i + 1), 'API chapter ' + (i + 1)),
    ).join('');
    response.end(
      html(
        'Fixture API manual',
        rows,
        `SCAN_API_CHAPTER_${chapter}. API chapter ${chapter} has distinct documentation content and a safe local fixture command.`,
      ),
    );
    return;
  }
  if (url.pathname === '/cdocs.php' || url.pathname === '/framework.html') {
    const family = url.pathname === '/cdocs.php' ? 'CLI' : 'Framework';
    response.end(
      html(
        'Fixture ' + family + ' manual',
        [1, 2].map((n) => link(url.pathname + '?chapter=' + n, family + ' chapter ' + n)).join(''),
        'SOURCE_' + family + '_ONLY',
      ),
    );
    return;
  }
  response.writeHead(404);
  response.end('Unknown local fixture');
});
async function hashFiles(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await hashFiles(path.join(directory, entry.name), prefix + entry.name + '/');
    else if (entry.isFile())
      report.sourceHashes[prefix + entry.name] = hash(
        await fs.readFile(path.join(directory, entry.name)),
      );
  }
}
async function savedTasks() {
  return panel.evaluate(async () => {
    const store = await import('./task-store.js');
    return Promise.all((await store.listTasks()).map((task) => store.loadTask(task.taskId)));
  });
}
async function waitTasks(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    latest = await savedTasks();
    const result = predicate(latest);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(latest?.map((task) => ({ entry: task.entry, status: task.status, chapters: task.queue.length, pages: Object.keys(task.pages).length })))}`,
  );
}
async function connectAddress(url, purpose) {
  if (purpose)
    await panel.locator(`[data-mode="${purpose === 'rotation' ? 'rotation' : 'web'}"]`).click();
  await panel.locator('#source-url').fill(url);
  await panel.locator('#source-connect').click();
  await panel.waitForFunction(
    (pathname) =>
      /已连接/.test(document.querySelector('#source-connect-status').textContent) &&
      !document.querySelector('#source-select').disabled &&
      document.querySelector('#connection').textContent.includes(pathname),
    new URL(url).pathname,
  );
  return Number(await panel.locator('#source-select').inputValue());
}
async function connectDocument(url) {
  return connectAddress(url, 'document');
}
async function sourceOptionIds() {
  return panel
    .locator('#source-select option')
    .evaluateAll((options) =>
      options.filter((option) => option.value).map((option) => Number(option.value)),
    );
}
async function blankWorkspace(panelURL) {
  // Refresh now restores background sources. Isolate routing cases by explicitly
  // detaching idle fixture sources; retain their archives for later assertions.
  if (panel.url().startsWith(panelURL))
    await panel.evaluate(async () => {
      const rpc = async (action, tabId) => {
        const result = await chrome.runtime.sendMessage({
          type: 'manualdock:runtime',
          action,
          tabId,
        });
        if (result.error) throw new Error(result.error);
        return result.value;
      };
      for (const source of await rpc('list')) {
        if (source.busy || source.state.canPause)
          throw new Error('Cannot reset a running fixture source');
        await rpc('remove', source.tabId);
      }
    });
  await panel.goto(panelURL);
  await panel.waitForFunction(() =>
    document.querySelector('#source-connect-status')?.textContent.includes('管理页'),
  );
  check(
    'fresh-workspace-keeps-default-rotation',
    {
      mode: await panel.locator('.app').getAttribute('data-current-mode'),
      button: await panel.locator('#source-connect').textContent(),
    },
    { mode: 'rotation', button: '连接管理页' },
  );
}
async function verifyDocumentEntry(name, url, sourceId) {
  await panel.waitForFunction(
    (id) =>
      document.querySelector('.app').dataset.currentMode === 'web' &&
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#source-select').disabled,
    sourceId,
  );
  check(
    name + '-routes-known-manual-to-recognition',
    {
      mode: await panel.locator('.app').getAttribute('data-current-mode'),
      button: await panel.locator('#source-connect').textContent(),
      documentSources: await sourceOptionIds(),
      selected: await panel.locator('#source-select').inputValue(),
    },
    { mode: 'web', button: '连接文档页', documentSources: [sourceId], selected: String(sourceId) },
  );
  check(
    name + '-opens-identification-controls',
    await panel.locator('[data-operation-panel="identify"]').isVisible(),
    true,
  );
  check(name + '-has-no-empty-error-strip', await panel.locator('#error').isVisible(), false);
  const row = panel.locator(`.batch-item[data-tab-id="${sourceId}"]`);
  check(
    name + '-only-connects-without-recognition-or-capture',
    {
      connectedOnly: /已连接，请先识别与校准/.test(
        await row.locator('.batch-progress').textContent(),
      ),
      savedTaskCount: (await savedTasks()).length,
      sourceURL: (await worker.evaluate((id) => chrome.tabs.get(id), sourceId)).url,
    },
    { connectedOnly: true, savedTaskCount: 0, sourceURL: url },
  );
  await panel.locator('[data-mode="rotation"]').click();
  check(name + '-does-not-register-a-rotation-source', await sourceOptionIds(), []);
  report.entryRouting ||= [];
  report.entryRouting.push({ name, url, tabId: sourceId, purpose: 'document', capturedPages: 0 });
}
async function defaultRotationRoutesKnownManuals(origin, panelURL) {
  const manualURLs = [
    origin + '/adocs.php?index=0&dataID=api-menu-item50',
    origin + '/cdocs.php?index=0&dataID=api-menu-item28',
  ];
  const sources = [];
  for (const url of manualURLs) {
    await blankWorkspace(panelURL);
    const id = await connectAddress(url);
    sources.push({ url, id });
    await verifyDocumentEntry('paste-' + new URL(url).pathname, url, id);
  }
  for (const { url, id } of sources) {
    await blankWorkspace(panelURL);
    await panel.goto(panelURL + '?tab=' + id);
    await verifyDocumentEntry('initial-tab-' + new URL(url).pathname, url, id);
  }
  for (const { url, id } of sources) {
    await blankWorkspace(panelURL);
    await worker.evaluate(
      async (tabId) => globalThis.fixtureAction(await chrome.tabs.get(tabId)),
      id,
    );
    await verifyDocumentEntry('toolbar-handoff-' + new URL(url).pathname, url, id);
  }
  check(
    'known-manual-entry-paths-reuse-one-workspace',
    context.pages().filter((page) => page.url().startsWith(panelURL)).length,
    1,
  );
  check('known-manual-entry-paths-create-no-tasks', await savedTasks(), []);
  await blankWorkspace(panelURL);
  stage(
    'default rotation routes API and CLI URL, initial-tab and toolbar entries to document without collecting',
  );
}
async function bulkStartsOnlyPrepared(origin, panelURL) {
  const readyURL = origin + '/bulk-ready/one.html';
  const readyId = await connectDocument(readyURL);
  await detectCurrent(2);
  const unknownURL = origin + '/bulk-unknown.php';
  const unknownId = await connectDocument(unknownURL);
  check(
    'new-document-opens-recognition-settings',
    {
      mode: await panel.locator('.app').getAttribute('data-current-mode'),
      identify: await panel.locator('[data-operation-panel="identify"]').isVisible(),
      manual: await panel.locator('#open-calibration').isEnabled(),
      alert: await panel.locator('#error').isVisible(),
    },
    { mode: 'web', identify: true, manual: true, alert: false },
  );
  await panel.locator('[data-mode="batch"]').click();
  check(
    'bulk-button-counts-only-prepared-source',
    await panel.locator('#batch-start-all').textContent(),
    '开始已就绪（1）',
  );
  await panel.locator('#batch-start-all').click();
  const finished = await waitTasks(
    (tasks) => tasks.find((task) => task.entry === readyURL && task.status === 'finished'),
    'prepared source finished',
    25000,
  );
  check('bulk-captured-two-real-chapters', Object.keys(finished.pages).length, 2);
  const unknownRow = panel.locator(`.batch-item[data-tab-id="${unknownId}"]`);
  check(
    'bulk-keeps-unrecognized-source-unmodified',
    {
      tasks: (await savedTasks()).filter((task) => task.entry === unknownURL).length,
      error: await unknownRow.locator('.batch-error').isVisible(),
      globalError: await panel.locator('#error').isVisible(),
      calibration: await unknownRow.locator('.batch-select').isEnabled(),
      bulkDisabled: await panel.locator('#batch-start-all').isDisabled(),
    },
    { tasks: 0, error: false, globalError: false, calibration: true, bulkDisabled: true },
  );
  await panel.screenshot({ path: path.join(root, 'docs', 'test-readiness-batch.png') });
  // A failed identification belongs to this source, including after switching away.
  await unknownRow.locator('.batch-select').click();
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    () =>
      !document.querySelector('#detect').disabled &&
      /未识别目录/.test(document.querySelector('#recognition-message').textContent),
  );
  check('unrecognized-source-has-local-guidance', await panel.locator('#error').isVisible(), false);
  await panel.locator('[data-mode="rotation"]').click();
  check(
    'source-error-does-not-follow-into-rotation',
    await panel.locator('#error').isVisible(),
    false,
  );
  await panel.locator('[data-mode="batch"]').click();
  check(
    'source-error-remains-on-correct-row',
    await unknownRow.locator('.batch-error').isVisible(),
    true,
  );
  check(
    'successful-source-has-no-other-source-error',
    await panel.locator(`.batch-item[data-tab-id="${readyId}"] .batch-error`).isVisible(),
    false,
  );
  await blankWorkspace(panelURL);
  stage(
    'bulk collection saved two chapters while skipping an unrecognized source, with local errors only',
  );
}

async function detectCurrent(expectedCount) {
  await panel.locator('[data-mode="web"]').click();
  await panel.locator('[data-operation="identify"]').click();
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    (count) =>
      document.querySelector('#found').textContent === String(count) &&
      !document.querySelector('#detect').disabled,
    expectedCount,
  );
}
async function scanningDoesNotOwnSelection(origin) {
  const aURL = origin + '/lazy-a/index.html';
  const aId = await connectDocument(aURL);
  const sourceA = context.pages().find((page) => page.url() === aURL);
  assert.ok(sourceA, 'lazy source A is a real browser tab');
  await detectCurrent(2);
  await panel.locator('[data-operation="collect"]').click();
  await panel.locator('#scan').click();
  await sourceA.waitForFunction(
    () => window.fixtureRequestedAt > 0 && window.fixtureLoadedAt === 0,
  );
  const requestDeadline = Date.now() + 1000;
  while (!childrenResponse && Date.now() < requestDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  check('A-lazy-children-request-in-flight', Boolean(childrenResponse), true);
  check(
    'URL-connect-remains-usable-during-A-scan',
    await panel.locator('#source-connect').isEnabled(),
    true,
  );
  check(
    'source-selection-remains-usable-during-A-scan',
    await panel.locator('#source-select').isEnabled(),
    true,
  );
  await panel.locator('[data-mode="rotation"]').click();
  check(
    'unknown-console-entry-retains-rotation-default',
    await panel.locator('#source-connect').textContent(),
    '连接管理页',
  );
  const consoleURL = origin + '/console';
  const consoleId = await connectAddress(consoleURL);
  check(
    'unknown-management-page-stays-rotation-during-A-scan',
    {
      mode: await panel.locator('.app').getAttribute('data-current-mode'),
      button: await panel.locator('#source-connect').textContent(),
      rotationSources: await sourceOptionIds(),
      loadedA: await sourceA.evaluate(() => window.fixtureLoadedAt),
      managementTasks: (await savedTasks()).filter((task) => task.entry === consoleURL).length,
    },
    {
      mode: 'rotation',
      button: '连接管理页',
      rotationSources: [consoleId],
      loadedA: 0,
      managementTasks: 0,
    },
  );
  const bURL = origin + '/docs-b/chapter-1.html';
  const bId = await connectDocument(bURL);
  await detectCurrent(2);
  check(
    'B-selected-before-A-completes',
    await panel.locator('#source-select').inputValue(),
    String(bId),
  );
  check(
    'A-still-waiting-after-B-recognition',
    await sourceA.evaluate(() => window.fixtureLoadedAt),
    0,
  );
  const bWhileAWaits = (await savedTasks()).find((task) => task.entry === bURL);
  check('B-scanned-while-A-waits', bWhileAWaits?.queue.length, 2);
  childrenResponse.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  childrenResponse.end(lazyChildren);
  childrenResponse = null;
  await sourceA.waitForFunction(() => window.fixtureLoadedAt > 0);
  const aTask = await waitTasks(
    (tasks) => tasks.find((task) => task.entry === aURL && task.queue.length === 4),
    'A full lazy directory',
  );
  const bTask = (await savedTasks()).find((task) => task.entry === bURL);
  check(
    'A-late-completion-keeps-B-selected',
    await panel.locator('#source-select').inputValue(),
    String(bId),
  );
  check('A-late-completion-keeps-B-counter', await panel.locator('#found').textContent(), '2');
  check(
    'A-directory-isolated',
    aTask.queue.every((chapter) => chapter.title.startsWith('A ')),
    true,
  );
  check(
    'B-directory-isolated',
    bTask.queue.every((chapter) => chapter.title.startsWith('B ')),
    true,
  );
  check(
    'scanning-does-not-capture-or-navigate',
    {
      aPages: Object.keys(aTask.pages).length,
      bPages: Object.keys(bTask.pages).length,
      aURL: sourceA.url(),
    },
    { aPages: 0, bPages: 0, aURL },
  );
  check(
    'unknown-management-page-excluded-from-document-sources',
    (await sourceOptionIds()).includes(consoleId),
    false,
  );
  report.concurrentScan = {
    consoleId,
    aId,
    bId,
    aChapters: aTask.queue.length,
    bChapters: bTask.queue.length,
    selectedAfterA: bId,
    lazyWaitMs: await sourceA.evaluate(() => window.fixtureLoadedAt - window.fixtureRequestedAt),
  };
  stage('A lazy scan completed after B connection and recognition without reclaiming selection');
}
async function deletedLargeTaskAndManualRules(origin) {
  const apiURL = origin + '/adocs.php?index=0&dataID=api-1';
  const apiId = await connectDocument(apiURL);
  const seed = await panel.evaluate(
    async ({ tabId, origin }) => {
      const store = await import('./task-store.js');
      const { validateProfile } = await import('./profiles.js');
      const { createTask, ImportEngine } = await import('./engine.js');
      const { createBrowserIO } = await import('./browser-io.js');
      const io = createBrowserIO(tabId);
      const detected = await io.detect();
      const api = validateProfile({
        ...detected.profile,
        id: 'retained-api-profile',
        name: 'Fixture API rule',
      });
      const cli = validateProfile({
        ...api,
        id: 'retained-cli-profile',
        name: 'Fixture CLI rule',
        entry: origin + '/cdocs.php?chapter=1',
        pathPrefix: '/',
        queryKeys: ['chapter'],
      });
      const framework = validateProfile({
        ...api,
        id: 'retained-framework-profile',
        name: 'Fixture Framework rule',
        entry: origin + '/framework.html?chapter=1',
        pathPrefix: '/',
        queryKeys: ['chapter'],
      });
      for (const profile of [api, cli, framework]) await store.saveProfile(profile);
      const task = createTask(api, api.name, '未知');
      const engine = new ImportEngine(task, {
        discover: (profile) => io.discover(profile, { expand: false }),
        save: (task) => store.saveTask(task),
      });
      await engine.scan();
      return {
        oldTaskId: task.taskId,
        oldProfileId: api.id,
        chapterCount: task.queue.length,
        profileIds: [api.id, cli.id, framework.id],
      };
    },
    { tabId: apiId, origin },
  );
  check('deleted-fixture-really-has-447-chapters', seed.chapterCount, 447);
  await panel.locator('[data-mode="library"]').click();
  const oldRow = panel.locator('#task-list .task-item').filter({ hasText: 'Fixture API rule' });
  await oldRow.waitFor();
  panel.once('dialog', (dialog) => dialog.accept());
  await oldRow.locator('.danger').click();
  await panel.waitForFunction(
    async (id) => (await import('./task-store.js')).loadTask(id).then((task) => task === null),
    seed.oldTaskId,
  );
  const deleted = await panel.evaluate(async (seed) => {
    const store = await import('./task-store.js');
    return {
      tombstone: await store.getSetting('deleted-task:' + seed.oldTaskId),
      retained: (await store.loadProfiles()).some((profile) => profile.id === seed.oldProfileId),
    };
  }, seed);
  check('UI-deletion-retains-profile-and-tombstone', deleted, { tombstone: true, retained: true });
  stage('447-chapter old task deleted through UI with its rule retained');
  await detectCurrent(447);
  const fresh = (await savedTasks()).find((task) => task.entry === apiURL);
  assert.ok(fresh, 'explicit UI recognition must persist a fresh task');
  check('re-recognition-uses-new-task-id', fresh.taskId !== seed.oldTaskId, true);
  check('re-recognition-keeps-all-447-chapters', fresh.queue.length, 447);
  check('historical-rule-chooser-removed', await panel.locator('#profile-list').count(), 0);
  check('fresh-API-task-keeps-own-scope', new URL(fresh.profile.entry).pathname, '/adocs.php');
  report.largeTask = {
    oldTaskId: seed.oldTaskId,
    freshTaskId: fresh.taskId,
    oldProfileId: seed.oldProfileId,
    freshProfileId: fresh.profileId,
    scannedChapters: fresh.queue.length,
  };
  await panel.locator('[data-operation="collect"]').click();
  await panel.locator('#start').click();
  const captured = await waitTasks(
    (tasks) =>
      tasks.find((task) => task.taskId === fresh.taskId && Object.keys(task.pages).length >= 1),
    'at least one real persisted API chapter',
    25000,
  );
  await panel.locator('#pause').click();
  const stopped = await waitTasks(
    (tasks) =>
      tasks.find(
        (task) => task.taskId === fresh.taskId && ['paused', 'finished'].includes(task.status),
      ),
    'explicit pause after successful capture',
  );
  const pages = Object.values(stopped.pages);
  check(
    'new-task-captures-real-fixture-body',
    pages.length >= 1 &&
      pages.every(
        (page) => /SCAN_API_CHAPTER_\d+/.test(page.text) && page.navigationProof?.verified === true,
      ),
    true,
  );
  check(
    'old-tombstone-remains-after-new-capture',
    await panel.evaluate(
      async (id) => (await import('./task-store.js')).getSetting('deleted-task:' + id),
      seed.oldTaskId,
    ),
    true,
  );
  check(
    'old-task-is-not-resurrected',
    (await savedTasks()).some((task) => task.taskId === seed.oldTaskId),
    false,
  );
  report.largeTask.persistedPages = pages.length;
  report.largeTask.firstCapturedPageCount = Object.keys(captured.pages).length;
  report.largeTask.finalStatus = stopped.status;
  report.largeTask.oldTombstoneRetained = true;
  stage('new 447-chapter identity began real capture without reviving the deleted task');
  for (const [pathname, ruleId] of [
    ['/cdocs.php?chapter=1', 'retained-cli-profile'],
    ['/framework.html?chapter=1', 'retained-framework-profile'],
  ]) {
    await connectDocument(origin + pathname);
    await panel.locator('[data-mode="web"]').click();
    await panel.locator('[data-operation="identify"]').click();
    check(
      pathname + '-has-no-historical-rule-chooser',
      await panel.locator('#profile-list').count(),
      0,
    );
  }
  stage('same-host documents connect without historical rule selection');
}
async function retrialRunningFramework(origin) {
  const documentSelection = await panel.locator('#source-select').inputValue();
  const documentSources = await sourceOptionIds();
  const orderedTasks = async () =>
    (await savedTasks())
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((task) => ({
        taskId: task.taskId,
        status: task.status,
        chapters: task.queue.length,
        pages: Object.keys(task.pages).length,
        // Compare the complete task without duplicating hundreds of chapters in the report.
        sha256: hash(JSON.stringify(task)),
      }));
  const documentTasks = await orderedTasks();
  const url = origin + '/framework.php';
  const frameworkId = await connectAddress(url, 'rotation');
  const sourcePage = context.pages().find((page) => page.url() === url);
  assert.ok(sourcePage, 'framework rotation source is a real browser tab');
  await panel.locator('#source-select').selectOption(String(frameworkId));
  await panel.waitForFunction(() => !document.querySelector('#rotation-preset').disabled);
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 3);
  await panel.locator('#rotation-interval').fill('30');
  await panel.locator('#rotation-interval').press('Tab');
  const titles = ['Dashboard', 'Resources', 'Connectivity'];
  await panel.evaluate(() => {
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    let delayed = false;
    chrome.scripting.executeScript = async (options) => {
      const result = await executeScript(options);
      if (!delayed && ['start', 'prepare'].includes(options.args?.[0])) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 4500));
      }
      return result;
    };
    window.restoreTrialTransport = () => {
      chrome.scripting.executeScript = executeScript;
    };
  });
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(
    () =>
      /试运行通过/.test(document.querySelector('#rotation-status').textContent) &&
      !document.querySelector('#rotation-start').disabled,
  );
  check(
    'delayed-framework-trial-clicks-each-selected-menu-exactly-once',
    await sourcePage.evaluate(() => window.fixtureMenuClicks),
    titles,
  );
  await panel.evaluate(() => window.restoreTrialTransport());
  await panel.locator('#rotation-start').click();
  await panel.waitForFunction(
    () =>
      /1 个管理页运行中/.test(document.querySelector('#rotation-background-status').textContent) &&
      /轮换已启动/.test(document.querySelector('#rotation-status').textContent),
  );
  const held = await panel.evaluate(
    async (id) =>
      (await navigator.locks.query()).held.some((lock) => lock.name === 'source-tab:' + id),
    frameworkId,
  );
  check('normal-framework-controller-holds-source-lock', held, true);
  await panel.locator('[data-mode="batch"]').click();
  await sourcePage.waitForFunction(() => window.fixtureMenuClicks.length >= 4, null, {
    timeout: 35000,
  });
  check(
    'normal-rotation-clicks-after-30-seconds-while-viewing-batch',
    await sourcePage.evaluate(() => window.fixtureMenuClicks),
    [...titles, titles[0]],
  );
  await panel.locator('[data-mode="rotation"]').click();
  check(
    'running-framework-allows-a-new-trial',
    await panel.locator('#rotation-trial').isEnabled(),
    true,
  );
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(
    () =>
      /试运行通过/.test(document.querySelector('#rotation-status').textContent) &&
      !document.querySelector('#rotation-start').disabled,
  );
  check(
    'framework-retrial-actually-clicks-all-menus-again',
    await sourcePage.evaluate(() => window.fixtureMenuClicks),
    [...titles, titles[0], ...titles],
  );
  const sourceState = await panel.evaluate(
    async (id) =>
      (
        await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => globalThis.SecurityNavigationRotation.snapshot(),
        })
      )[0].result,
    frameworkId,
  );
  check(
    'framework-retrial-stops-controller-and-page-runner',
    {
      footerStopped: /未运行/.test(
        await panel.locator('#rotation-background-status').textContent(),
      ),
      pageRunning: sourceState.running,
      sourceLockAvailable: await panel.evaluate(
        (id) =>
          navigator.locks.request('source-tab:' + id, { ifAvailable: true }, (lock) =>
            Boolean(lock),
          ),
        frameworkId,
      ),
    },
    { footerStopped: true, pageRunning: false, sourceLockAvailable: true },
  );
  await panel.locator('[data-mode="web"]').click();
  check(
    'framework-retrial-keeps-document-selection-and-sources',
    {
      selected: await panel.locator('#source-select').inputValue(),
      sources: await sourceOptionIds(),
    },
    { selected: documentSelection, sources: documentSources },
  );
  check('framework-retrial-leaves-document-tasks-unchanged', await orderedTasks(), documentTasks);
  await panel.locator('[data-mode="rotation"]').click();
  await sourcePage.close();
  await panel.waitForFunction((id) => {
    const option = [...document.querySelector('#source-select').options].find(
      (option) => option.value === String(id),
    );
    return Boolean(option) && /已关闭/.test(option.textContent);
  }, frameworkId);
  const closedLabel = await panel
    .locator(`#source-select option[value="${frameworkId}"]`)
    .textContent();
  check(
    'closed-framework-source-is-explicitly-unavailable',
    {
      labelMarkedClosed: /已关闭/.test(closedLabel),
      trialDisabled: await panel.locator('#rotation-trial').isDisabled(),
      presetDisabled: await panel.locator('#rotation-preset').isDisabled(),
      startDisabled: await panel.locator('#rotation-start').isDisabled(),
    },
    { labelMarkedClosed: true, trialDisabled: true, presetDisabled: true, startDisabled: true },
  );
  const replacement = await context.newPage();
  await replacement.goto(url);
  const replacementId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    url,
  );
  await worker.evaluate(
    async (id) => globalThis.fixtureAction(await chrome.tabs.get(id)),
    replacementId,
  );
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#rotation-preset').disabled &&
      !document.querySelector('#rotation-trial').disabled,
    replacementId,
  );
  check(
    'toolbar-new-framework-tab-replaces-closed-selection',
    {
      selected: await panel.locator('#source-select').inputValue(),
      mode: await panel.locator('.app').getAttribute('data-current-mode'),
      preset: await panel.locator('#rotation-preset').isEnabled(),
      trial: await panel.locator('#rotation-trial').isEnabled(),
    },
    { selected: String(replacementId), mode: 'rotation', preset: true, trial: true },
  );
  await panel.locator('#source-select').selectOption(String(frameworkId));
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      document.querySelector('#rotation-trial').disabled &&
      !document.querySelector('#rotation-remove').disabled &&
      document.querySelectorAll('#rotation-targets li').length === 3,
    frameworkId,
  );
  check(
    'closed-framework-can-be-selected-readonly-with-its-original-draft',
    {
      selected: await panel.locator('#source-select').inputValue(),
      targets: await panel
        .locator('#rotation-targets li')
        .evaluateAll((items) =>
          items.map((item) => item.firstChild.textContent.replace(/^\d+\.\s*/, '')),
        ),
      interval: await panel.locator('#rotation-interval').inputValue(),
      trialDisabled: await panel.locator('#rotation-trial').isDisabled(),
      presetDisabled: await panel.locator('#rotation-preset').isDisabled(),
      startDisabled: await panel.locator('#rotation-start').isDisabled(),
      removeEnabled: await panel.locator('#rotation-remove').isEnabled(),
    },
    {
      selected: String(frameworkId),
      targets: titles,
      interval: '30',
      trialDisabled: true,
      presetDisabled: true,
      startDisabled: true,
      removeEnabled: true,
    },
  );
  await panel.locator('#rotation-remove').click();
  await panel.waitForFunction(
    (id) =>
      ![...document.querySelector('#source-select').options].some(
        (option) => option.value === String(id),
      ),
    frameworkId,
  );
  check(
    'old-closed-framework-slot-is-removed-after-replacement',
    (await sourceOptionIds()).includes(frameworkId),
    false,
  );
  await panel.locator('#source-select').selectOption(String(replacementId));
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#rotation-preset').disabled &&
      !document.querySelector('#rotation-trial').disabled,
    replacementId,
  );
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 3);
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(
    () =>
      /试运行通过/.test(document.querySelector('#rotation-status').textContent) &&
      !document.querySelector('#rotation-start').disabled,
  );
  check(
    'replacement-framework-tab-can-identify-and-trial',
    await replacement.evaluate(() => window.fixtureMenuClicks),
    titles,
  );
  check(
    'framework-tab-replacement-leaves-document-tasks-unchanged',
    await orderedTasks(),
    documentTasks,
  );
  await replacement.close();
  await panel.waitForFunction((id) => {
    const option = [...document.querySelector('#source-select').options].find(
      (option) => option.value === String(id),
    );
    return Boolean(option) && /已关闭/.test(option.textContent);
  }, replacementId);
  check(
    'closed-replacement-management-source-can-be-removed',
    await panel.locator('#rotation-remove').isEnabled(),
    true,
  );
  await panel.locator('#rotation-remove').click();
  await panel.waitForFunction(
    (id) =>
      ![...document.querySelector('#source-select').options].some(
        (option) => option.value === String(id),
      ),
    replacementId,
  );
  check(
    'closed-replacement-management-source-was-removed',
    (await sourceOptionIds()).includes(replacementId),
    false,
  );
  report.runningRotationRetrial = {
    tabId: frameworkId,
    entry: url,
    intervalMs: 30000,
    observedNormalInterval: false,
    menuClicks: [...titles, ...titles],
    sourceLockReleased: true,
    otherDocumentsUnchanged: true,
    closedSourceLabel: closedLabel,
    replacementTabId: replacementId,
    replacementViaProductionAction: true,
    replacementMenuClicks: titles,
    closedReplacementRemoved: true,
    oldClosedSourceSelectedReadonlyAndRemoved: true,
  };
  stage(
    'framework retrial stopped the running controller, replayed three menus and released only its source lock',
  );
}
async function pickManualRegion(sourcePage, kind, target) {
  await panel.locator('#pick-' + kind).click();
  await sourcePage.locator('[data-security-picker]').first().waitFor();
  const sourceURL = sourcePage.url();
  await sourcePage.locator(target).click();
  await sourcePage.waitForFunction(() => !document.querySelector('[data-security-picker]'));
  await panel.waitForFunction((kind) => !document.querySelector('#pick-' + kind).disabled, kind);
  check('manual-' + kind + '-picker-suppresses-source-navigation', sourcePage.url(), sourceURL);
}
async function manualCalibrationAfterFailedRecognition(origin) {
  const manualURL = origin + '/opaque.php?chapter=1';
  const manualId = await connectDocument(manualURL);
  const sourcePage = context.pages().find((page) => page.url() === manualURL);
  assert.ok(sourcePage, 'manual calibration source is a real browser tab');
  await panel.locator('[data-mode="web"]').click();
  await panel.locator('[data-operation="identify"]').click();
  check(
    'unidentified-document-offers-manual-calibration',
    await panel.locator('#open-calibration').isEnabled(),
    true,
  );
  await panel.locator('#open-calibration').click();
  check(
    'unidentified-document-offers-directory-and-body-pickers',
    {
      open: await panel.locator('#calibration-dialog').evaluate((dialog) => dialog.open),
      toc: await panel.locator('#pick-toc').isEnabled(),
      content: await panel.locator('#pick-content').isEnabled(),
    },
    { open: true, toc: true, content: true },
  );
  await panel.locator('#calibration-dialog [data-close-dialog]').click();
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    () =>
      !document.querySelector('#detect').disabled &&
      /未识别目录/.test(document.querySelector('#recognition-message').textContent) &&
      document.querySelector('#found').textContent === '0',
  );
  const detectionError = await panel.locator('#recognition-message').textContent();
  check(
    'recognition-failure-has-no-global-banner',
    await panel.locator('#error').isVisible(),
    false,
  );
  check(
    'opaque-structure-fails-recognition-without-enabling-start',
    {
      found: await panel.locator('#found').textContent(),
      start: await panel.locator('#start').isEnabled(),
      savedTasks: (await savedTasks()).filter((task) => task.entry === manualURL).length,
      manual: await panel.locator('#open-calibration').isEnabled(),
    },
    { found: '0', start: false, savedTasks: 0, manual: true },
  );
  await panel.locator('#open-calibration').click();
  await pickManualRegion(sourcePage, 'toc', '#x7 a:first-child');
  await pickManualRegion(sourcePage, 'content', '#x9 h1');
  check(
    'manual-pickers-update-both-selectors-after-failure',
    {
      toc: await panel.locator('#toc-selector').inputValue(),
      content: await panel.locator('#content-selector').inputValue(),
      verify: await panel.locator('#verify').isEnabled(),
    },
    { toc: '#x7', content: '#x9', verify: true },
  );
  await panel.locator('#verify').click();
  await panel.waitForFunction(
    () =>
      /两个示例验证通过/.test(document.querySelector('#profile-status').textContent) &&
      !document.querySelector('#verify').disabled,
  );
  const verified = await waitTasks(
    (tasks) =>
      tasks.find(
        (task) => task.entry === manualURL && task.queue.length === 2 && task.validation?.signature,
      ),
    'manually calibrated two-chapter task with persisted validation',
  );
  check(
    'manual-two-chapter-validation-is-persisted-before-start',
    {
      toc: verified.profile.tocSelector,
      content: verified.profile.contentSelector,
      samples: verified.profile.samples.length,
      chapters: verified.queue.length,
      pages: Object.keys(verified.pages).length,
    },
    { toc: '#x7', content: '#x9', samples: 2, chapters: 2, pages: 0 },
  );
  await panel.locator('#calibration-dialog [data-close-dialog]').click();
  await panel.locator('[data-operation="collect"]').click();
  check('manually-validated-document-can-start', await panel.locator('#start').isEnabled(), true);
  await panel.locator('#start').click();
  await waitTasks(
    (tasks) =>
      tasks.find((task) => task.taskId === verified.taskId && Object.keys(task.pages).length >= 1),
    'manual calibration workflow persisted a captured chapter',
    20000,
  );
  await panel.locator('#pause').click();
  const captured = await waitTasks(
    (tasks) =>
      tasks.find(
        (task) => task.taskId === verified.taskId && ['paused', 'finished'].includes(task.status),
      ),
    'manual capture paused or completed',
  );
  const pages = Object.values(captured.pages);
  check(
    'manual-recovery-captures-the-selected-body',
    pages.length >= 1 &&
      pages.every(
        (page) =>
          /MANUAL_PICK_CHAPTER_[12]/.test(page.text) && page.navigationProof?.verified === true,
      ),
    true,
  );
  report.manualCalibration = {
    manualId,
    entry: manualURL,
    detectionError,
    taskId: captured.taskId,
    selectors: { toc: verified.profile.tocSelector, content: verified.profile.contentSelector },
    verifiedChapters: verified.queue.length,
    persistedPages: pages.length,
    finalStatus: captured.status,
  };
  stage(
    'failed unknown-page recognition recovered through real directory/body picking, verification and capture',
  );
  const freshURL = origin + '/opaque-fresh.php?chapter=1';
  const freshId = await connectDocument(freshURL);
  const freshSource = context.pages().find((page) => page.url() === freshURL);
  assert.ok(freshSource, 'pre-recognition manual source is a real browser tab');
  await panel.locator('[data-mode="web"]').click();
  await panel.locator('[data-operation="identify"]').click();
  check(
    'second-manual-source-starts-without-a-rule-or-task',
    {
      toc: await panel.locator('#toc-selector').inputValue(),
      content: await panel.locator('#content-selector').inputValue(),
      savedTasks: (await savedTasks()).filter((task) => task.entry === freshURL).length,
    },
    { toc: '', content: '', savedTasks: 0 },
  );
  await panel.locator('#open-calibration').click();
  await pickManualRegion(freshSource, 'toc', '#x7 a:first-child');
  await pickManualRegion(freshSource, 'content', '#x9 h1');
  check(
    'new-document-can-pick-both-regions-without-any-detect',
    {
      toc: await panel.locator('#toc-selector').inputValue(),
      content: await panel.locator('#content-selector').inputValue(),
      verify: await panel.locator('#verify').isEnabled(),
      savedTasks: (await savedTasks()).filter((task) => task.entry === freshURL).length,
    },
    { toc: '#x7', content: '#x9', verify: true, savedTasks: 0 },
  );
  report.manualCalibration.beforeAnyDetection = {
    tabId: freshId,
    entry: freshURL,
    tocSelector: '#x7',
    contentSelector: '#x9',
    capturedPages: 0,
  };
  await panel.locator('#calibration-dialog [data-close-dialog]').click();
  stage('a separate unidentified source accepted both manual picks without running detection');
}
async function scenario() {
  await fs.cp(sourceExtension, fixtureExtension, { recursive: true });
  await hashFiles(fixtureExtension);
  const background = path.join(fixtureExtension, 'background.js');
  const actionShim = `const originalActionListener = chrome.action.onClicked.addListener.bind(chrome.action.onClicked);
chrome.action.onClicked.addListener = listener => { globalThis.fixtureAction = listener; originalActionListener(listener); };
`;
  await fs.writeFile(background, actionShim + (await fs.readFile(background, 'utf8')));
  const manifestPath = path.join(fixtureExtension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(
    manifest.host_permissions,
    undefined,
    'shipping manifest must not request install-time website permission',
  );
  report.extensionVersion = manifest.version;
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${fixtureExtension}`,
      `--load-extension=${fixtureExtension}`,
    ],
  });
  context.setDefaultTimeout(12000);
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  context.on('page', (page) =>
    page.on('pageerror', (error) => sourceErrors.push({ url: page.url(), message: error.message })),
  );
  panel.on('pageerror', (error) => sourceErrors.push({ url: panel.url(), message: error.message }));
  const panelURL = `chrome-extension://${extensionId}/panel.html`;
  await defaultRotationRoutesKnownManuals(origin, panelURL);
  await bulkStartsOnlyPrepared(origin, panelURL);
  await scanningDoesNotOwnSelection(origin);
  await deletedLargeTaskAndManualRules(origin);
  await retrialRunningFramework(origin);
  await manualCalibrationAfterFailedRecognition(origin);
  check('no-browser-script-errors', sourceErrors, []);
  report.browserVersion = context.browser().version();
  report.passed = true;
}
try {
  await Promise.race([
    scenario(),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('scan workspace exceeded its 120-second execution limit')),
        120000,
      );
    }),
  ]);
} catch (error) {
  report.error = error.message;
  report.stack = error.stack;
  report.failureUI = await panel
    ?.evaluate(() => ({
      selected: document.querySelector('#source-select')?.value,
      source: document.querySelector('#connection')?.textContent,
      error: document.querySelector('#error')?.textContent,
      mode: document.querySelector('.app')?.dataset.currentMode,
      status: document.querySelector('#status')?.textContent,
      found: document.querySelector('#found')?.textContent,
    }))
    .catch(() => null);
  report.tasksAtFailure = await savedTasks()
    .then((tasks) =>
      tasks.map((task) => ({
        taskId: task.taskId,
        entry: task.entry,
        status: task.status,
        chapters: task.queue.length,
        pages: Object.keys(task.pages).length,
      })),
    )
    .catch(() => []);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await context?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
  report.temporaryFilesRemoved = true;
  report.elapsedMs = Date.now() - started;
  report.testedAt = new Date().toISOString();
  report.requests = requestLog;
  await fs.writeFile(path.join(root, 'docs', reportName), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        elapsedMs: report.elapsedMs,
        checks: report.checks.length,
        error: report.error,
        stages: report.stages,
        largeTask: report.largeTask,
        temporaryFilesRemoved: true,
      },
      null,
      2,
    ),
  );
}
