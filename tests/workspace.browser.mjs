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
const executablePath = process.env.MANUALDOCK_CHROMIUM_EXECUTABLE;
const started = Date.now();
const sourceExtension = await fs.realpath(
  process.env.MANUALDOCK_EXTENSION_SOURCE || path.join(root, 'extension'),
);
assert.ok(
  sourceExtension.startsWith(root + path.sep),
  'fixture source must stay inside this repository',
);
const regressionsOnly = process.env.MANUALDOCK_WORKSPACE_REGRESSIONS_ONLY === '1';
const reportName = process.env.MANUALDOCK_WORKSPACE_REPORT || 'browser-test-workspace.json';
assert.equal(path.basename(reportName), reportName, 'report name must not escape docs');
const behaviorFailures = [];
const temporary = await fs.mkdtemp(path.join(internal, 'workspace-browser-'));
const fixtureExtension = path.join(temporary, 'extension');
const errors = [],
  requests = [],
  extensionHashes = {},
  checkpoints = [];
let context, panel, sourceA, sourceB, worker, deadline, liveRotation;
const report = {
  passed: false,
  fixtureOnly: true,
  isolatedProfile: true,
  realDeviceNotTested: true,
  simulatedToolbarHandoff: true,
  rotationIntervalUsedMs: 30000,
  rotationStartedThroughUI: true,
  controllerIntervalPatched: false,
  executionLimitMs: 120000,
  scriptSha256: createHash('sha256')
    .update(await fs.readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  extraFixturePermission: 'http://127.0.0.1/*',
  extensionHashes,
  regressionsOnly,
  periodicRotationChecksSkipped: regressionsOnly,
  behaviorChecks: [],
  behaviorFailures,
  errors,
  checkpoints,
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push(url.pathname);
  const consoleMatch = /^\/console-([ab])\.html$/.exec(url.pathname);
  if (consoleMatch) {
    const family = consoleMatch[1].toUpperCase();
    response.writeHead(200, {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Workspace Console ${family}</title><link rel="icon" href="data:,"><header><div class="console-main-menu"><a href="#/dashboard">${family} Dashboard</a><a href="#/resources">${family} Resources</a><a href="#/connectivity">${family} Connectivity</a></div></header><main><h1>Console ${family}</h1></main><button>Save</button><script>window.clicks=[];window.clickEvents=JSON.parse(sessionStorage.getItem('fixture-clicks')||'[]');window.fixtureLoad=Number(sessionStorage.getItem('fixture-load')||0)+1;sessionStorage.setItem('fixture-load',String(window.fixtureLoad));document.querySelector('.console-main-menu').onclick=e=>{window.clicks.push(e.target.textContent);window.clickEvents.push({title:e.target.textContent,at:Date.now(),load:window.fixtureLoad});sessionStorage.setItem('fixture-clicks',JSON.stringify(window.clickEvents));};</script>`,
    );
    return;
  }
  if (url.pathname === '/cdocs.php') {
    response.writeHead(200, {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const rows = [28, 29]
      .map(
        (id, i) =>
          `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf ${i === 0 ? 'x-tree-selected' : ''}" ext:tree-node-id="api-menu-item${id}"><span>CLI Chapter ${i + 1}</span></div><ul class="x-tree-node-ct"></ul></li>`,
      )
      .join('');
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Synthetic CLI manual</title><link rel="icon" href="data:,"><div id="content"><ul class="x-tree-root-ct">${rows}</ul><div id="articleContent"><h1>CLI Chapter 1</h1><pre>show interface</pre><p>Local fixture command documentation only.</p></div></div>`,
    );
    return;
  }
  const match = /^\/docs-([ab])\/([abcd])\.html$/.exec(url.pathname);
  if (!match) {
    response.writeHead(404);
    response.end('Fixture path not found');
    return;
  }
  const family = match[1].toUpperCase(),
    chapter = match[2].toUpperCase();
  const links = ['a', 'b', 'c', 'd']
    .map(
      (letter) =>
        `<a href="/docs-${match[1]}/${letter}.html">${family} Chapter ${letter.toUpperCase()}</a>`,
    )
    .join('');
  setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(200, {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Workspace Manual ${family}</title><link rel="icon" href="data:,"><nav aria-label="Manual chapters">${links}</nav><main><h1>${family} Chapter ${chapter}</h1><p>SOURCE_${family}_ONLY. Chapter ${chapter} explains fixture ${family} settings and provides unique chapter content.</p><pre>fixture-${family}-${chapter}</pre></main>`,
    );
  }, 250);
});
function stage(name) {
  checkpoints.push({ name, elapsedMs: Date.now() - started });
  console.log(`workspace browser: ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
}
async function hashFiles(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await hashFiles(path.join(directory, entry.name), prefix + entry.name + '/');
    else if (entry.isFile())
      extensionHashes[prefix + entry.name] = createHash('sha256')
        .update(await fs.readFile(path.join(directory, entry.name)))
        .digest('hex');
  }
}
async function tasks() {
  return panel.evaluate(async () => {
    const store = await import('./task-store.js');
    return Promise.all((await store.listTasks()).map((task) => store.loadTask(task.taskId)));
  });
}
async function waitTasks(condition, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    const saved = (await tasks()).filter((task) =>
      /\/docs-[ab]\//.test(new URL(task.entry).pathname),
    );
    latest = Object.fromEntries(
      saved.map((task) => [
        new URL(task.entry).pathname.includes('/docs-a/') ? 'a' : 'b',
        {
          taskId: task.taskId,
          status: task.status,
          captured: task.queue.filter((chapter) => chapter.status === 'captured').length,
          savedPages: Object.keys(task.pages).length,
        },
      ]),
    );
    const { a, b } = latest;
    if (condition === 'both-running' && a?.status === 'running' && b?.status === 'running')
      return latest;
    if (condition === 'a-has-saved-page' && a?.captured >= 1 && a.savedPages >= 1 && a.captured < 4)
      return latest;
    if (
      condition === 'a-paused-b-finished' &&
      a?.status === 'paused' &&
      b?.status === 'finished' &&
      b.captured === 4
    )
      return latest;
    if (
      condition === 'both-finished' &&
      a?.status === 'finished' &&
      a.captured === 4 &&
      b?.status === 'finished' &&
      b.captured === 4
    )
      return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${condition}: ${JSON.stringify(latest)}`);
}

/** Record independent UI assertions so one regression does not hide the other. */
function checkBehavior(name, actual, expected) {
  const entry = { name, actual, expected, passed: false };
  report.behaviorChecks.push(entry);
  try {
    assert.deepEqual(actual, expected, name);
    entry.passed = true;
  } catch (error) {
    behaviorFailures.push({ name, actual, expected, message: error.message });
  }
}

/** Connect through the visible URL form and wait until source selection is complete. */
async function connectAddress(url, purpose = 'document') {
  await panel.locator(`[data-mode="${purpose === 'rotation' ? 'rotation' : 'web'}"]`).click();
  await panel.locator('#source-url').fill(url);
  await panel.locator('#source-connect').click();
  await panel.waitForFunction(
    (pathname) =>
      /已连接/.test(document.querySelector('#source-connect-status').textContent) &&
      !document.querySelector('#source-connect').disabled &&
      !document.querySelector('#source-select').disabled &&
      document.querySelector('#connection').textContent.includes(pathname),
    new URL(url).pathname,
  );
}

/** Read the actual isolated-world menu runner after real UI actions. */
async function rotationSnapshot(tabId) {
  return worker.evaluate(async (id) => {
    const values = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => globalThis.SecurityNavigationRotation?.snapshot() || { running: false, count: 0 },
    });
    return values[0].result;
  }, tabId);
}

/** Role lists are user-facing evidence; the controller and interval remain untouched. */
async function verifyRoleIsolation(sourceIds, consoleId, selectedDocumentId) {
  const expectedDocuments = [sourceIds.a, sourceIds.b].map(String).sort();
  for (const mode of ['batch', 'web', 'library']) {
    await panel.locator(`[data-mode="${mode}"]`).click();
    const ids = await panel.locator('#source-select option').evaluateAll((options) =>
      options
        .map((option) => option.value)
        .filter(Boolean)
        .sort(),
    );
    checkBehavior(mode + '-offers-only-document-sources', ids, expectedDocuments);
    checkBehavior(
      mode + '-keeps-document-selection',
      await panel.locator('#source-select').inputValue(),
      String(selectedDocumentId),
    );
    checkBehavior(
      mode + '-rotation-remains-running',
      /1 个管理页运行中/.test(await panel.locator('#rotation-background-status').textContent()),
      true,
    );
  }
  // The visible workbench is paginated. Check the complete rendered collection,
  // not just whichever page remains mounted while the library tab is active.
  await panel.locator('[data-mode="batch"]').click();
  for (let i = 0; i < 8 && !(await panel.locator('#batch-prev').isDisabled()); i++)
    await panel.locator('#batch-prev').click();
  assert.equal(await panel.locator('#batch-prev').isDisabled(), true);
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(
      ...(await panel
        .locator('.batch-item')
        .evaluateAll((items) => items.map((item) => item.dataset.tabId))),
    );
    if (await panel.locator('#batch-next').isDisabled()) break;
    await panel.locator('#batch-next').click();
  }
  assert.equal(await panel.locator('#batch-next').isDisabled(), true);
  checkBehavior('collection-rows-exclude-management-page', rows.sort(), expectedDocuments);
  for (let i = 0; i < 8 && !(await panel.locator('#batch-prev').isDisabled()); i++)
    await panel.locator('#batch-prev').click();
  await panel.locator('[data-mode="rotation"]').click();
  const rotationOptions = await panel
    .locator('#source-select option')
    .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  checkBehavior('rotation-offers-only-management-source', rotationOptions, [String(consoleId)]);
  checkBehavior(
    'rotation-selection-independent-of-document',
    await panel.locator('#source-select').inputValue(),
    String(consoleId),
  );
  await panel.locator('[data-mode="batch"]').click();
}

/** Start with the real UI's minimum 30-second interval before both documents collect. */
async function startIndependentRotation(origin, sourceIds) {
  await connectAddress(origin + '/console-a.html', 'rotation');
  const page = context.pages().find((page) => new URL(page.url()).pathname === '/console-a.html');
  assert.ok(page, 'management fixture must be open');
  page.on('pageerror', (error) => errors.push('management: ' + error.message));
  const tabId = Number(await panel.locator('#source-select').inputValue());
  checkBehavior('management-connection-creates-no-document-task', (await tasks()).length, 0);
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 3);
  await panel.locator('#rotation-interval').fill('30');
  await panel.locator('#rotation-interval').press('Tab');
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(
    () =>
      document.querySelector('#rotation-status').textContent.includes('试运行通过') &&
      !document.querySelector('#rotation-start').disabled,
    null,
    { timeout: 12000 },
  );
  const before = await page.evaluate(() => window.clickEvents.length);
  const startedAt = Date.now();
  await panel.locator('#rotation-start').click();
  await panel.waitForFunction(() =>
    /1 个管理页运行中/.test(document.querySelector('#rotation-background-status').textContent),
  );
  const result = { page, tabId, before, startedAt };
  await verifyRoleIsolation(sourceIds, tabId, sourceIds.a);
  report.rolesSeparated = true;
  stage('30-second UI rotation started independently of document sources');
  return result;
}

/** Observe a full UI interval, reload recovery, and the original page's stop control. */
async function finishIndependentRotation(rotation, sourceIds) {
  const { page, tabId, before } = rotation;
  await panel.locator('[data-mode="library"]').click();
  await page.waitForFunction((before) => window.clickEvents.length >= before + 1, before, {
    timeout: 38000,
  });
  const periodic = await page.evaluate((before) => window.clickEvents.slice(before), before);
  checkBehavior(
    'real-30-second-UI-interval-dispatched-first-click',
    periodic[0].at - rotation.startedAt >= 29900,
    true,
  );
  checkBehavior(
    'periodic-menu-order-survives-column-switches',
    periodic.slice(0, 1).map((event) => event.title),
    ['A Dashboard'],
  );
  checkBehavior(
    'document-capture-never-created-management-task',
    (await tasks()).some((task) => new URL(task.entry).pathname.startsWith('/console-')),
    false,
  );
  report.uiRotationIntervals = { firstIntervalMs: periodic[0].at - rotation.startedAt };
  stage('real 30-second interval completed across collection and column switches');
  const previousLoad = await page.evaluate(() => window.fixtureLoad);
  const previousClick = periodic.at(-1);
  await page.reload();
  await verifyRoleIsolation(sourceIds, tabId, sourceIds.b);
  await panel.locator('[data-mode="library"]').click();
  await page.waitForFunction(
    (load) => window.clickEvents.some((event) => event.load > load),
    previousLoad,
    { timeout: 38000 },
  );
  const resumed = await page.evaluate(
    (load) => window.clickEvents.filter((event) => event.load > load),
    previousLoad,
  );
  checkBehavior('management-reload-resumes-next-menu', resumed[0].title, 'A Resources');
  checkBehavior(
    'management-reload-preserves-next-deadline',
    resumed[0].at - previousClick.at >= 29900,
    true,
  );
  checkBehavior(
    'management-reload-controller-still-running',
    (await rotationSnapshot(tabId)).running,
    true,
  );
  report.uiRotationIntervals.reloadIntervalMs = resumed[0].at - previousClick.at;
  stage('reloaded management document resumed at the next 30-second deadline');
  await page.locator('[data-security-navigation-stop]').click();
  await panel.waitForFunction(
    () => document.querySelector('#rotation-background-status').textContent === '菜单轮换未运行',
  );
  await panel.locator('[data-mode="rotation"]').click();
  await panel.waitForFunction(() =>
    document.querySelector('#rotation-status').textContent.includes('已停止'),
  );
  checkBehavior('source-overlay-stops-controller', (await rotationSnapshot(tabId)).running, false);
  const lockReleased = await panel.evaluate(
    async (id) =>
      navigator.locks.request('source-tab:' + id, { ifAvailable: true }, (lock) => Boolean(lock)),
    tabId,
  );
  checkBehavior('source-overlay-releases-controller-source-lock', lockReleased, true);
  const stoppedCount = await page.evaluate(() => window.clickEvents.length);
  await page.waitForTimeout(1100);
  checkBehavior(
    'source-overlay-stop-dispatches-no-immediate-extra-click',
    await page.evaluate(() => window.clickEvents.length),
    stoppedCount,
  );
  report.overlayStopEvidence =
    'real page stop button; workspace stopped status; source lock released; 1100 ms without another click (not a full post-stop interval)';
  report.managementReloadResumed = true;
  report.managementOverlayStoppedController = true;
  stage('original-page stop propagated to the workspace scheduler');
}

/** Exercise input clearing and unsaved trials on synthetic local console pages only. */
async function runUIRegressions(origin, connectedSourceId) {
  // Each role retains its own source selection; choose the surviving document.
  await panel.locator('[data-mode="batch"]').click();
  await panel.locator('#source-select').selectOption(String(connectedSourceId));
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#source-select').disabled,
    connectedSourceId,
  );
  await panel.locator('[data-mode="rotation"]').click();
  await panel.locator('#rotation-interval').fill('73');
  await panel.locator('#rotation-interval').press('Tab');
  await panel.locator('[data-mode="spec"]').click();
  await panel.locator('#product').fill('UI preservation fixture');
  await panel.locator('#version').fill('9.8.7');
  await panel.locator('label[for="spec-remote-tab"]').click();
  await panel.locator('#spec-url').fill(origin + '/not-requested-openapi.json');
  const configSnapshot = () =>
    panel.evaluate(() => ({
      product: document.querySelector('#product').value,
      version: document.querySelector('#version').value,
      specificationURL: document.querySelector('#spec-url').value,
      rotationInterval: document.querySelector('#rotation-interval').value,
    }));
  const preserved = await configSnapshot();
  for (const mode of ['rotation', 'batch', 'web', 'spec', 'library']) {
    await panel.locator('#source-url').fill(origin + '/unsent-' + mode);
    await panel.locator(`[data-mode="${mode}"]`).click();
    checkBehavior(
      'mode-' + mode + '-clears-source-url',
      await panel.locator('#source-url').inputValue(),
      '',
    );
    checkBehavior('mode-' + mode + '-preserves-config', await configSnapshot(), preserved);
  }
  stage('five mode switches inspected without submitting typed URLs');

  // Hash routes are part of URL identity. Reconnect the exact surviving tab,
  // rather than opening a second console and reading the first one's click log.
  const consoleA = liveRotation.page;
  await connectAddress(consoleA.url(), 'rotation');
  assert.ok(!consoleA.isClosed(), 'console A must remain connected');
  consoleA.on('pageerror', (error) => errors.push('consoleA: ' + error.message));
  const consoleAId = Number(await panel.locator('#source-select').inputValue());
  assert.equal(consoleAId, liveRotation.tabId, 'reconnect must select the observed management tab');
  const expectedTitles = ['A Dashboard', 'A Resources', 'A Connectivity'];
  const targetTitles = () =>
    panel
      .locator('#rotation-targets li')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.firstChild.textContent.replace(/^\d+\.\s*/, '')),
      );
  async function trialA(interval) {
    await panel.locator('#rotation-preset').click();
    await panel.waitForFunction(
      () => document.querySelectorAll('#rotation-targets li').length === 3,
    );
    assert.deepEqual(
      await targetTitles(),
      expectedTitles,
      'fixture console menus must be recognized',
    );
    await panel.locator('#rotation-interval').fill(String(interval));
    await panel.locator('#rotation-interval').press('Tab');
    await panel.locator('#rotation-trial').click();
    await panel.waitForFunction(
      () =>
        document.querySelector('#rotation-status').textContent.includes('试运行通过') &&
        !document.querySelector('#rotation-start').disabled,
      null,
      { timeout: 12000 },
    );
    assert.equal(
      await panel.locator('#rotation-save').isEnabled(),
      true,
      'trial must visibly succeed before reconnect',
    );
    assert.deepEqual((await consoleA.evaluate(() => window.clicks)).slice(-3), expectedTitles);
    const persisted = await panel.evaluate(
      async (key) => (await import('./task-store.js')).getSetting(key),
      'rotation:' + origin,
    );
    assert.equal(persisted == null, true, 'this scenario must not save the trial configuration');
  }
  async function attemptStart(name, id, expectedRunning) {
    await panel.locator('#rotation-start').click();
    await panel.waitForFunction(
      () =>
        document.querySelector('#rotation-status').textContent.includes('已启动') ||
        document.querySelector('#error').textContent.length > 0,
    );
    const snapshot = await rotationSnapshot(id);
    checkBehavior(name, snapshot.running, expectedRunning);
    report.behaviorChecks.at(-1).panelError = await panel.locator('#error').textContent();
    report.behaviorChecks.at(-1).rotationStatus = await panel
      .locator('#rotation-status')
      .textContent();
    if (
      snapshot.running ||
      /运行中/.test(await panel.locator('#rotation-background-status').textContent())
    ) {
      await panel.locator('#rotation-stop').click();
      await panel.waitForFunction(() =>
        document.querySelector('#rotation-status').textContent.includes('已停止'),
      );
    }
  }

  await trialA(117);
  const pagesBeforeReconnect = context.pages().length;
  await connectAddress(consoleA.url(), 'rotation');
  checkBehavior(
    'reconnect-same-url-reuses-source-tab',
    context.pages().length,
    pagesBeforeReconnect,
  );
  checkBehavior(
    'unsaved-trial-targets-survive-same-url-reconnect',
    await targetTitles(),
    expectedTitles,
  );
  checkBehavior(
    'unsaved-trial-interval-survives-same-url-reconnect',
    await panel.locator('#rotation-interval').inputValue(),
    '117',
  );
  await attemptStart('unsaved-trial-starts-after-same-url-reconnect', consoleAId, true);
  stage('unsaved trial inspected after reconnecting the same URL');

  // Establish a fresh verified A draft so this check is independent of the reconnect result.
  await trialA(83);
  await connectAddress(origin + '/console-b.html', 'rotation');
  const consoleB = context
    .pages()
    .find((page) => new URL(page.url()).pathname === '/console-b.html');
  assert.ok(consoleB, 'console B must be connected');
  consoleB.on('pageerror', (error) => errors.push('consoleB: ' + error.message));
  const consoleBId = Number(await panel.locator('#source-select').inputValue());
  checkBehavior('same-origin-other-source-does-not-inherit-targets', await targetTitles(), []);
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 3);
  checkBehavior('other-source-has-own-recognized-targets', await targetTitles(), [
    'B Dashboard',
    'B Resources',
    'B Connectivity',
  ]);
  await attemptStart('other-source-cannot-borrow-A-trial', consoleBId, false);
  checkBehavior(
    'unverified-other-source-did-not-click',
    await consoleB.evaluate(() => window.clicks),
    [],
  );
  await panel.locator('#source-select').selectOption(String(consoleAId));
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#source-select').disabled,
    consoleAId,
  );
  checkBehavior(
    'unsaved-trial-targets-survive-source-roundtrip',
    await targetTitles(),
    expectedTitles,
  );
  checkBehavior(
    'unsaved-trial-interval-survives-source-roundtrip',
    await panel.locator('#rotation-interval').inputValue(),
    '83',
  );
  await attemptStart('unsaved-trial-starts-after-source-roundtrip', consoleAId, true);
  report.menuTrialSavedToStorage = false;
  report.syntheticConsoleOrigins = [origin];
  report.sameOriginSourceIsolation = report.behaviorChecks
    .filter((check) =>
      [
        'same-origin-other-source-does-not-inherit-targets',
        'other-source-has-own-recognized-targets',
        'other-source-cannot-borrow-A-trial',
        'unverified-other-source-did-not-click',
      ].includes(check.name),
    )
    .every((check) => check.passed);
  await trialA(60);
  await panel.locator('#rotation-targets button').first().click();
  checkBehavior(
    'edited-menu-invalidates-save',
    await panel.locator('#rotation-save').isDisabled(),
    true,
  );
  checkBehavior(
    'edited-menu-removes-stale-success',
    /试运行通过|可保存规则或开始轮换/.test(await panel.locator('#rotation-status').textContent()),
    false,
  );
  checkBehavior(
    'edited-menu-explains-required-retrial',
    /重新试运行/.test(await panel.locator('#rotation-status').textContent()),
    true,
  );

  const cliURL = origin + '/cdocs.php?index=0&dataID=api-menu-item28cli';
  await connectAddress(cliURL);
  checkBehavior(
    'synthetic-cli-connection-does-not-create-task',
    (await tasks()).some((task) => task.entry === cliURL),
    false,
  );
  await panel.locator('[data-mode="web"]').click();
  checkBehavior(
    'new-source-recognition-settings-visible',
    await panel.locator('[data-operation-panel="identify"]').isVisible(),
    true,
  );
  checkBehavior(
    'new-source-recognition-tab-enabled',
    await panel.locator('[data-operation="identify"]').isEnabled(),
    true,
  );
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    () =>
      document.querySelector('#found').textContent === '2' &&
      !document.querySelector('#detect').disabled,
  );
  const cliTask = (await tasks()).find((task) => task.entry === cliURL);
  checkBehavior(
    'synthetic-cli-explicit-detection-discovers-two-chapters',
    cliTask?.queue.length,
    2,
  );
  checkBehavior(
    'synthetic-cli-detection-does-not-start-capture',
    Object.keys(cliTask?.pages || {}).length,
    0,
  );
  checkBehavior(
    'synthetic-cli-uses-visible-article-region',
    cliTask?.profile.contentSelector,
    '#articleContent',
  );
  report.syntheticCliRecognition = true;
  report.syntheticCliIsNotTargetDeviceDOM = true;
  stage('menu edits and fresh CLI recognition entry inspected');
  stage('source roundtrip and independent unverified source inspected');
}

async function scenario() {
  await fs.cp(sourceExtension, fixtureExtension, { recursive: true });
  await hashFiles(fixtureExtension);
  const background = path.join(fixtureExtension, 'background.js');
  const actionShim = `const originalActionListener = chrome.action.onClicked.addListener.bind(chrome.action.onClicked);
chrome.action.onClicked.addListener = listener => { globalThis.fixtureAction = listener; originalActionListener(listener); };
`;
  await fs.writeFile(background, actionShim + (await fs.readFile(background, 'utf8')));
  const manifest = JSON.parse(
    await fs.readFile(path.join(fixtureExtension, 'manifest.json'), 'utf8'),
  );
  assert.equal(
    manifest.host_permissions,
    undefined,
    'shipping manifest must not require install-time website access',
  );
  report.extensionVersion = manifest.version;
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(fixtureExtension, 'manifest.json'), JSON.stringify(manifest));
  await fs.mkdir(path.join(temporary, 'downloads'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath,
    headless: true,
    acceptDownloads: true,
    downloadsPath: path.join(temporary, 'downloads'),
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${fixtureExtension}`,
      `--load-extension=${fixtureExtension}`,
    ],
  });
  context.setDefaultTimeout(15000);
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  panel.on('pageerror', (error) => errors.push('panel: ' + error.message));
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.locator('#source-url').waitFor();
  assert.equal(
    await panel.locator('.mode-nav button').first().getAttribute('data-mode'),
    'rotation',
  );
  assert.equal(await panel.locator('.app').getAttribute('data-current-mode'), 'rotation');
  assert.deepEqual(await tasks(), [], 'an empty workspace must not create a collection task');
  const workspaceTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const located = await worker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'manualdock:locate-workspace' }),
  );
  assert.equal(located?.workspace?.id, workspaceTabId);
  sourceA = await context.newPage();
  sourceA.on('pageerror', (error) => errors.push('sourceA: ' + error.message));
  await sourceA.goto(origin + '/docs-a/a.html');
  const sourceIds = {
    a: await worker.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0].id,
      sourceA.url(),
    ),
    b: null,
  };
  await panel.locator('[data-mode="web"]').click();
  await worker.evaluate(
    async (tabId) => globalThis.fixtureAction(await chrome.tabs.get(tabId)),
    sourceIds.a,
  );
  await panel.waitForFunction(
    (id) => document.querySelector('#source-select').value === String(id),
    sourceIds.a,
  );
  assert.equal(await panel.locator('.app').getAttribute('data-current-mode'), 'web');
  const pagesBefore = context.pages().length;
  await connectAddress(sourceA.url(), 'document');
  assert.equal(
    context.pages().length,
    pagesBefore,
    'same URL must reuse its existing document tab',
  );
  assert.equal(await panel.locator('.app').getAttribute('data-current-mode'), 'web');
  assert.deepEqual(await tasks(), [], 'document connection must not recognize or start collection');
  await connectAddress(origin + '/docs-b/a.html', 'document');
  sourceB = context.pages().find((page) => new URL(page.url()).pathname === '/docs-b/a.html');
  assert.ok(sourceB, 'document B must be opened');
  sourceB.on('pageerror', (error) => errors.push('sourceB: ' + error.message));
  sourceIds.b = Number(await panel.locator('#source-select').inputValue());
  assert.equal(await panel.locator('.app').getAttribute('data-current-mode'), 'web');
  assert.deepEqual(await tasks(), [], 'URL connection must not scan or start collection');
  await panel.locator('#source-select').selectOption(String(sourceIds.a));
  await panel.waitForFunction(
    (id) =>
      document.querySelector('#source-select').value === String(id) &&
      !document.querySelector('#source-select').disabled,
    sourceIds.a,
  );
  assert.match(await panel.locator('#connection').textContent(), /docs-a/);
  await worker.evaluate(
    async (tabId) => globalThis.fixtureAction(await chrome.tabs.get(tabId)),
    sourceIds.b,
  );
  assert.equal(
    context
      .pages()
      .filter((page) => page.url().startsWith(`chrome-extension://${extensionId}/panel.html`))
      .length,
    1,
  );
  assert.equal(await panel.locator('iframe').count(), 0);
  assert.equal(await panel.locator('.batch-item').count(), 2);
  report.productionActionRoutesExercised = 2;
  report.permissionFreeWorkspaceHandshake = true;
  report.urlEntryReusedExistingPage = true;
  report.urlEntryOpenedNewPage = true;
  report.rotationIsDefault = true;
  report.connectionDoesNotCreateTasks = true;
  report.sourceSelectorSwitchesTarget = true;
  report.permissionPromptPregrantedInFixture = true;
  stage('role-aware URL and toolbar entry reused one workspace without collecting');
  liveRotation = await startIndependentRotation(origin, sourceIds);
  if (regressionsOnly) {
    // Keep real role-aware UI start/stop, but deliberately omit the two full
    // 30-second intervals while checking legacy interaction expectations.
    await panel.locator('[data-mode="rotation"]').click();
    await panel.locator('#rotation-stop').click();
    await panel.waitForFunction(
      () => document.querySelector('#rotation-background-status').textContent === '菜单轮换未运行',
    );
    await runUIRegressions(origin, sourceIds.a);
    assert.deepEqual(errors, []);
    assert.equal(behaviorFailures.length, 0, 'workspace UI behavior regressions');
    report.browserVersion = context.browser().version();
    report.passed = true;
    return;
  }
  report.singleWorkspace = true;
  report.sourceRows = 2;
  report.workspaceIframes = 0;
  for (const id of [sourceIds.a, sourceIds.b]) {
    await panel.locator('[data-mode="web"]').click();
    await panel.locator('#source-select').selectOption(String(id));
    await panel.locator('[data-operation="identify"]').click();
    await panel.locator('#detect').click();
    await panel.waitForFunction(
      () =>
        document.querySelector('#found').textContent === '4' &&
        !document.querySelector('#detect').disabled,
    );
  }
  await panel.locator('[data-mode="batch"]').click();
  await panel.locator('#batch-start-all').click();
  await waitTasks('both-running');
  await verifyRoleIsolation(sourceIds, liveRotation.tabId, sourceIds.b);
  await panel.locator('[data-mode="library"]').click();
  await panel.locator('[data-mode="web"]').click();
  await panel.locator('[data-mode="batch"]').click();
  assert.equal(await panel.locator('.batch-item .batch-pause:not([disabled])').count(), 2);
  report.simultaneousRunning = true;
  stage('both real source sessions running');
  await waitTasks('a-has-saved-page');
  await panel.locator(`.batch-item[data-tab-id="${sourceIds.a}"] .batch-pause`).click();
  await waitTasks('a-paused-b-finished');
  await panel
    .locator(`.batch-item[data-tab-id="${sourceIds.a}"] .batch-start:not([disabled])`)
    .waitFor();
  const interrupted = (await tasks()).find((task) => task.entry.includes('/docs-a/'));
  const savedBeforeResume = structuredClone(interrupted.pages);
  assert.ok(
    Object.keys(savedBeforeResume).length >= 1 && Object.keys(savedBeforeResume).length < 4,
  );
  report.pausedSourceCaptured = Object.keys(savedBeforeResume).length;
  report.otherSourceCompletedWhilePaused = true;
  stage('one source paused while the other completed');

  await panel.locator(`.batch-item[data-tab-id="${sourceIds.a}"] .batch-start`).click();
  await panel.locator('[data-mode="library"]').click();
  const libraryA = panel.locator('#task-list .task-item').filter({ hasText: '/docs-a/' });
  await libraryA.waitFor();
  // Earlier role checks opened this view, so an existing row may precede the
  // current asynchronous refresh. Require current progress, not mere presence.
  await panel.waitForFunction(
    (minimum) => {
      const row = [...document.querySelectorAll('#task-list .task-item')].find((row) =>
        row.textContent.includes('/docs-a/'),
      );
      const captured = Number(row?.textContent.match(/已保存 (\d+)\/4/)?.[1]);
      return Number.isFinite(captured) && captured >= minimum;
    },
    Object.keys(savedBeforeResume).length,
    { timeout: 5000 },
  );
  await panel.waitForFunction(
    () => {
      const row = [...document.querySelectorAll('#task-list .task-item')].find((row) =>
        row.textContent.includes('/docs-a/'),
      );
      return row?.textContent.includes('已保存 4/4');
    },
    null,
    { timeout: 25000 },
  );
  await waitTasks('both-finished');
  assert.match(await panel.locator('#sync-status').textContent(), /已同步/);
  const finished = (await tasks()).filter((task) =>
    /\/docs-[ab]\//.test(new URL(task.entry).pathname),
  );
  assert.equal(finished.length, 2);
  for (const task of finished) {
    const family = task.entry.includes('/docs-a/') ? 'A' : 'B';
    assert.equal(task.queue.length, 4);
    assert.equal(Object.keys(task.pages).length, 4);
    for (const [key, record] of Object.entries(task.pages)) {
      assert.ok(key.includes(`/docs-${family.toLowerCase()}/`));
      assert.ok(record.url.includes(`/docs-${family.toLowerCase()}/`));
      assert.match(record.text, new RegExp(`SOURCE_${family}_ONLY`));
      assert.doesNotMatch(record.text, new RegExp(`SOURCE_${family === 'A' ? 'B' : 'A'}_ONLY`));
      assert.equal(record.navigationProof.verified, true);
    }
  }
  const resumed = finished.find((task) => task.entry.includes('/docs-a/'));
  for (const [key, record] of Object.entries(savedBeforeResume))
    assert.deepEqual(
      resumed.pages[key],
      record,
      'resume must preserve every already-saved record, including timestamps',
    );
  report.resumedWithoutChangingSavedPages = true;
  report.libraryUpdatedWithoutManualRefresh = true;
  report.noCrossSourceContent = true;
  report.finalCaptured = finished.map((task) => ({
    source: new URL(task.entry).pathname,
    count: Object.keys(task.pages).length,
  }));
  stage('resume and live library sync preserved both sources');
  await finishIndependentRotation(liveRotation, sourceIds);

  await panel.locator('[data-mode="batch"]').click();
  await sourceB.close();
  await panel.waitForFunction(
    (tabId) =>
      document
        .querySelector(`.batch-item[data-tab-id="${tabId}"] .batch-error`)
        ?.textContent.includes('已关闭'),
    sourceIds.b,
  );
  assert.equal(
    await panel.locator(`.batch-item[data-tab-id="${sourceIds.b}"] .batch-start`).isDisabled(),
    true,
  );
  assert.equal(
    (await tasks())
      .find((task) => task.entry.includes('/docs-b/'))
      .queue.filter((chapter) => chapter.status === 'captured').length,
    4,
  );
  assert.deepEqual(errors, []);
  report.sourceCloseNotified = true;
  report.closedSourceSavedPagesPreserved = true;
  report.browserVersion = context.browser().version();
  report.extensionVersion = manifest.version;
  stage('source closure stopped controls and retained saved pages');
  await runUIRegressions(origin, sourceIds.a);
  assert.deepEqual(errors, []);
  assert.equal(behaviorFailures.length, 0, 'workspace UI behavior regressions');
  report.passed = true;
}
try {
  await Promise.race([
    scenario(),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('workspace browser test exceeded its 120-second execution limit')),
        120000,
      );
    }),
  ]);
} catch (error) {
  report.error = error.message;
  report.stack = error.stack;
  report.workspaceState = await panel
    ?.locator('#batch-list')
    .textContent()
    .catch(() => 'unavailable');
  report.panelError = await panel
    ?.locator('#error')
    .textContent()
    .catch(() => 'unavailable');
  report.tasksAtFailure = await tasks().catch(() => []);
  report.rotationAtFailure = await panel
    ?.evaluate(() => ({
      mode: document.querySelector('.app')?.dataset.currentMode,
      status: document.querySelector('#rotation-status')?.textContent,
      background: document.querySelector('#rotation-background-status')?.textContent,
      mode: document.querySelector('.app')?.dataset.currentMode,
      selected: document.querySelector('#source-select')?.value,
    }))
    .catch(() => null);
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
  report.fixtureRequests = requests.length;
  await fs.writeFile(path.join(root, 'docs', reportName), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        elapsedMs: report.elapsedMs,
        error: report.error,
        checkpoints,
        finalCaptured: report.finalCaptured,
        behaviorFailures,
        errors,
        temporaryFilesRemoved: true,
      },
      null,
      2,
    ),
  );
}
