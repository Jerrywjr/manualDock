import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.TMPDIR = path.join(root, 'internal');
await fs.mkdir(process.env.TMPDIR, { recursive: true });
const temp = await fs.mkdtemp(path.join(root, 'internal/runtime-browser-'));
const started = Date.now(),
  checks = [],
  errors = [];
let context, deadline;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (url.pathname === '/console.html')
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>Console</title><link rel="icon" href="data:,"><header><div class="console-main-menu"><a href="#/one">One</a><a href="#/two">Two</a></div></header><main>Console</main><script>window.clicks=[];document.querySelector('.console-main-menu').onclick=e=>clicks.push(e.target.textContent)</script>`,
    );
  const prefix = url.pathname.startsWith('/other/') ? '/other/' : '/docs/';
  const chapter = Number(url.pathname.match(/(\d+)/)?.[1] || 1);
  setTimeout(
    () =>
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Runtime manual</title><link rel="icon" href="data:,"><nav>${Array.from({ length: 12 }, (_, i) => `<a href="${prefix}${i + 1}.html">Chapter ${i + 1}</a>`).join('')}</nav><main><h1>Chapter ${chapter}</h1><p>Distinct body for chapter ${chapter}.</p></main>`,
      ),
    200,
  );
});
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  console.log(name);
};
try {
  const extension = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    headless: true,
    executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error')
      console.log('browser console:', message.text());
  });
  deadline = setTimeout(() => void context.close(), 120000);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const connect = async (url, purpose) => {
    await panel.locator(`[data-mode="${purpose === 'rotation' ? 'rotation' : 'web'}"]`).click();
    await panel.locator('#source-url').fill(url);
    await panel.locator('#source-connect').click();
    await panel.waitForFunction(
      () =>
        !document.querySelector('#source-connect').disabled &&
        document.querySelector('#source-select').value,
    );
    return Number(await panel.locator('#source-select').inputValue());
  };
  const manager = await connect(origin + '/console.html', 'rotation');
  await panel.locator('#rotation-preset').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rotation-targets li').length === 2);
  await panel.locator('#rotation-interval').fill('30');
  await panel.locator('#rotation-interval').press('Tab');
  await panel.locator('#rotation-trial').click();
  await panel.waitForFunction(() => !document.querySelector('#rotation-start').disabled);
  await panel.locator('#rotation-start').click();
  await panel.waitForFunction(() =>
    document.querySelector('#rotation-background-status').textContent.includes('1 个管理页运行中'),
  );
  const management = context.pages().find((p) => p.url().includes('/console.html'));
  const baseline = await management.evaluate(() => clicks.length);
  const source = await connect(origin + '/docs/1.html', 'document');
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    () =>
      document.querySelector('#found').textContent === '12' &&
      !document.querySelector('#detect').disabled,
  );
  await panel.locator('[data-mode="batch"]').click();
  await panel.locator('#batch-start-all').click();
  let activePath = '/docs/';
  const progress = () =>
    panel.evaluate(async (pathname) => {
      const store = await import('./task-store.js');
      return (await store.listTasks()).find((task) =>
        new URL(task.entry).pathname.startsWith(pathname),
      );
    }, activePath);
  const waitTask = async (predicate, limit = 70000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      const task = await progress();
      if (predicate(task)) return task;
      await panel.waitForTimeout(150);
    }
    throw new Error('Timed out waiting for task: ' + JSON.stringify(await progress()));
  };
  await waitTask((task) => task?.queue.some((c) => c.status === 'captured'));
  const before = (await progress()).queue.filter((c) => c.status === 'captured').length;
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('#source-select option').length > 1);
  await waitTask((task) => task?.queue.filter((c) => c.status === 'captured').length > before);
  check('collection progresses after panel reload', true);
  const rpc = (action, tabId) =>
    panel.evaluate(
      async ({ action, tabId }) => {
        const r = await chrome.runtime.sendMessage({ type: 'manualdock:runtime', action, tabId });
        if (r.error) throw new Error(r.error);
        return r.value;
      },
      { action, tabId },
    );
  check(
    'rotation still running after panel reload',
    (await rpc('rotation:snapshot', manager)).running,
  );
  const originalPages = await panel.evaluate(
    async (id) => (await (await import('./task-store.js')).loadTask(id)).pages,
    (await progress()).taskId,
  );
  // Kill the actual extension worker, then reconnect the control page. Its
  // in-memory sessions and timers are gone; recovery must use persisted state.
  const cdp = await context.newCDPSession(panel);
  const versions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => versions.push(...event.versions));
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; !versions.some((v) => v.scriptURL === worker.url()) && i < 30; i++)
    await panel.waitForTimeout(100);
  console.log('worker versions', JSON.stringify(versions));
  const version = versions.find(
    (v) => v.scriptURL === worker.url() && v.runningStatus === 'running',
  );
  assert.ok(version, 'active worker version exists');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  for (
    let i = 0;
    !versions.some((v) => v.versionId === version.versionId && v.runningStatus === 'stopped') &&
    i < 30;
    i++
  )
    await panel.waitForTimeout(100);
  check(
    'browser reports actual worker termination',
    versions.some((v) => v.versionId === version.versionId && v.runningStatus === 'stopped'),
  );
  await cdp.detach();
  await panel.reload();
  const completed = await waitTask((task) => task?.status === 'finished');
  console.log(
    JSON.stringify(
      completed.queue.map((c) => ({ title: c.title, status: c.status, error: c.error })),
    ),
  );
  check(
    'all 12 chapters saved after worker termination',
    completed.queue.filter((c) => c.status === 'captured').length === 12,
  );
  const finalPages = await panel.evaluate(
    async (id) => (await (await import('./task-store.js')).loadTask(id)).pages,
    completed.taskId,
  );
  for (const [key, page] of Object.entries(originalPages)) assert.deepEqual(finalPages[key], page);
  check('previously saved bodies and timestamps are unchanged', true);
  check(
    'refresh and worker restart preserve exactly two source bindings',
    (await rpc('list')).length === 2,
  );
  await management.waitForFunction((n) => clicks.length > n, baseline, { timeout: 40000 });
  check('30-second rotation continues across panel and worker restart', true);
  await rpc('rotation:stop', manager);
  await panel.reload();
  check(
    'manual stop remains stopped after panel reload',
    !(await rpc('rotation:snapshot', manager)).running,
  );
  activePath = '/other/';
  const other = await connect(origin + '/other/1.html', 'document');
  await panel.locator('#detect').click();
  await panel.waitForFunction(
    () =>
      document.querySelector('#found').textContent === '12' &&
      !document.querySelector('#detect').disabled,
  );
  await rpc('start', other);
  await waitTask((task) => task?.queue.some((c) => c.status === 'captured'));
  await rpc('pause', other);
  const paused = await waitTask((task) => task?.status === 'paused' && !task.autoRecovery?.enabled);
  const pausedCount = paused.queue.filter((c) => c.status === 'captured').length;
  await panel.reload();
  await panel.waitForTimeout(6500);
  const afterPause = await progress();
  check(
    'manual pause survives reload past the first retry interval',
    !afterPause.autoRecovery.enabled &&
      afterPause.queue.filter((c) => c.status === 'captured').length === pausedCount,
  );
  check('no panel JavaScript errors', errors.length === 0);
} finally {
  clearTimeout(deadline);
  await context?.close();
  await new Promise((r) => server.close(r));
  await fs.rm(temp, { recursive: true, force: true });
  await fs.writeFile(
    path.join(root, 'docs/browser-test-runtime.json'),
    JSON.stringify(
      {
        fixtureOnly: true,
        liveDevice: false,
        elapsedMs: Date.now() - started,
        checks,
        errors,
        temporaryFilesRemoved: true,
      },
      null,
      2,
    ) + '\n',
  );
}
