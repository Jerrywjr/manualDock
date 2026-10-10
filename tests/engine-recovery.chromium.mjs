// Real-Chromium breakpoint-recovery + Web-Lock occupancy verification.
//
// Level of testing (per review brief §3/§6):
//   * Real headless Chromium (Playwright), NOT jsdom.
//   * REAL extension modules loaded as ES modules: engine.js / task-store.js /
//     recovery.js / profiles.js / core.js / sangfor-rules.js.
//   * REAL browser-native IndexedDB (no fake-indexeddb) and REAL navigator.locks.
//   * Capture is driven through a controllable `io` (deterministic bodies); the
//     storage / checkpoint / resume / lock logic is the production code path.
//
// What this does NOT cover (documented as residual in the final report):
//   * Real content-script capture via manual-adapters.js against a live manual
//     site (would require loading the full MV3 extension + a faithful mock site).
//   * panel.js chrome.scripting-dependent paths (checkBind/openTask). Those are
//     exercised at the Node/unit level where their pure logic is reachable and
//     reviewed here for the chrome-dependent parts.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', 'extension');
const CHROMIUM = process.env.MANUALDOCK_CHROMIUM_EXECUTABLE
  || '/Users/Jerry/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const MIME = { '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        let p = decodeURIComponent(u.pathname);
        if (p === '/' || p === '/blank') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end('<!doctype html><title>blank</title><body>blank</body>'); return; }
        if (p.startsWith('/ext/')) {
          const file = path.join(EXT_DIR, p.slice('/ext/'.length));
          if (!file.startsWith(EXT_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
        res.writeHead(404); res.end('nf');
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PROFILE = { id: 'p1', revision: 1, origin: 'https://manual.example.com', entry: 'https://manual.example.com/', queryKeys: [], pathPrefix: '/', tocSelector: '', contentSelector: '' };

test('real Chromium: breakpoint recovery — capture 4/10, close control page, resume on a new tab to the end', { timeout: 60000 }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage(); // first control page
    await pageA.goto(`${base}/blank`);

    // Boot the real engine on page A, scan, and run — but hang on chapter 5.
    await pageA.evaluate(async (profile) => {
      const { ImportEngine, createTask } = await import('/ext/engine.js');
      const { saveTask } = await import('/ext/task-store.js');
      const realIo = {
        discover: async () => ({ status: 'ok', items: Array.from({ length: 10 }, (_, i) => ({ url: `https://manual.example.com/ch${i + 1}`, title: `Chapter ${i + 1}` })) }),
        capture: async (chapter) => { if (chapter.key === 'url:https://manual.example.com/ch5') return new Promise(() => {}); return { status: 'ok', text: `BODY-${chapter.key}`, html: `<p>${chapter.key}</p>`, navigationProof: { verified: true } }; },
        save: saveTask,
      };
      const task = createTask(profile, 'ChromiumBreak', '1.0');
      await saveTask(task);
      const engine = new ImportEngine(task, realIo);
      engine.scan().then(() => engine.run()); // fire and forget; hangs on ch5
    }, PROFILE);

    // Poll (from a separate probe page sharing the same IndexedDB) until 4 captured.
    const probe = await ctx.newPage();
    await probe.goto(`${base}/blank`);
    let captured = 0; let before = null;
    for (let i = 0; i < 100; i++) {
      const snap = await probe.evaluate(async (prof) => {
        const { loadTask } = await import('/ext/task-store.js');
        const { jobKey } = await import('/ext/profiles.js');
        const t = await loadTask(jobKey(prof, 'ChromiumBreak', '1.0'));
        return t ? { captured: t.queue.filter(c => c.status === 'captured').length, pages: t.pages } : null;
      }, PROFILE);
      if (snap && snap.captured >= 4) { captured = snap.captured; before = snap.pages; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(captured, 4, 'expected exactly 4 chapters captured before the control page was closed');
    assert.ok(before && before['url:https://manual.example.com/ch1'] && before['url:https://manual.example.com/ch4'], 'first four pages must be persisted before close');

    // Simulate "control page closed" — kill page A while ch5 capture is hanging.
    await pageA.close();

    // New control page (different tab/page) — load the saved task and resume.
    const pageB = await ctx.newPage();
    await pageB.goto(`${base}/blank`);
    const result = await pageB.evaluate(async (profile) => {
      const { ImportEngine } = await import('/ext/engine.js');
      const { saveTask, loadTask } = await import('/ext/task-store.js');
      const { jobKey } = await import('/ext/profiles.js');
      const taskId = jobKey(profile, 'ChromiumBreak', '1.0');
      const saved = await loadTask(taskId);
      const io = {
        discover: async () => ({ status: 'ok', items: Array.from({ length: 10 }, (_, i) => ({ url: `https://manual.example.com/ch${i + 1}`, title: `Chapter ${i + 1}` })) }),
        capture: async (chapter) => ({ status: 'ok', text: `BODY-${chapter.key}`, html: `<p>${chapter.key}</p>`, navigationProof: { verified: true } }),
        save: saveTask,
      };
      const engine = new ImportEngine(saved, io);
      await engine.run();
      const final = await loadTask(taskId);
      return { status: final.status, queue: final.queue.map(c => c.status), pages: Object.keys(final.pages), pageCount: Object.keys(final.pages).length, ch1: final.pages['url:https://manual.example.com/ch1']?.text, ch4: final.pages['url:https://manual.example.com/ch4']?.text, ch5: final.pages['url:https://manual.example.com/ch5']?.text };
    }, PROFILE);

    assert.equal(result.status, 'finished', 'task should finish after resuming');
    assert.equal(result.pageCount, 10, 'all 10 chapters must be captured with no duplicates/omissions');
    // First four must NOT have been overwritten by the resume.
    assert.equal(result.ch1, 'BODY-url:https://manual.example.com/ch1', 'chapter 1 body must be intact after resume');
    assert.equal(result.ch4, 'BODY-url:https://manual.example.com/ch4', 'chapter 4 body must be intact after resume');
    assert.equal(result.ch5, 'BODY-url:https://manual.example.com/ch5', 'chapter 5 must be captured on resume');
    // No chapter left pending/processing/failed.
    assert.ok(result.queue.every(s => s === 'captured' || s === 'review'), 'no chapter left pending/processing/failed: ' + JSON.stringify(result.queue));
  } finally {
    await browser.close();
    server.close();
  }
});

test('real Chromium: Web Locks block a second executor on the same task (task:<id>)', { timeout: 30000 }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext();
    // Executor 1 acquires and holds the lock (callback receives a truthy Lock).
    const holder = await ctx.newPage();
    await holder.goto(`${base}/blank`);
    const firstGranted = await holder.evaluate(() => new Promise((res) => {
      navigator.locks.request('task:LOCKTEST', { ifAvailable: true }, (lock) => { res(Boolean(lock)); return new Promise(() => {}); });
    }));
    assert.ok(firstGranted, 'first executor should acquire the task lock and receive a truthy Lock');

    // Executor 2 must be denied while the lock is held: the callback is invoked
    // but with a falsy `lock` (this is the contract panel.js relies on: if(!lock) throw).
    const contender = await ctx.newPage();
    await contender.goto(`${base}/blank`);
    const secondGranted = await contender.evaluate(() => new Promise((res) => {
      navigator.locks.request('task:LOCKTEST', { ifAvailable: true }, (lock) => { res(Boolean(lock)); return new Promise(() => {}); });
      setTimeout(() => res(false), 1500); // safety: never resolve if callback never fires
    }));
    assert.equal(secondGranted, false, 'a second executor must NOT acquire the task lock while held');

    // Sanity: the lock is still held by exactly one client.
    const held = await contender.evaluate(() => navigator.locks.query().then(q => q.held.filter(l => l.name === 'task:LOCKTEST').length));
    assert.equal(held, 1, 'the task lock should remain held by the single holder');

    // After the holder closes, the lock frees and a new executor can acquire it.
    await holder.close();
    const late = await ctx.newPage();
    await late.goto(`${base}/blank`);
    const recovered = await late.evaluate(() => new Promise((res) => {
      navigator.locks.request('task:LOCKTEST', { ifAvailable: true }, (lock) => { res(Boolean(lock)); return new Promise(() => {}); });
      setTimeout(() => res(false), 1500);
    }));
    assert.equal(recovered, true, 'lock should free once the holder closes, allowing a new executor');
  } finally {
    await browser.close();
    server.close();
  }
});

test('real Chromium: faultOf redacts credentials in the browser module path', { timeout: 30000 }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/blank`);
    const out = await page.evaluate(async () => {
      const { faultOf } = await import('/ext/recovery.js');
      const e = new Error('GET https://docs.example.com/api/toc?token=SECRETTOKEN&api_key=AK123 failed: Authorization: Bearer eyJabc.def.ghi ; Cookie: sess=XYZ');
      const f = faultOf(e, 'capture-chapter', { key: 'k1', title: 'T1' });
      return { message: f.message, stack: f.stack };
    });
    for (const secret of ['SECRETTOKEN', 'AK123', 'eyJabc', 'sess=XYZ']) {
      assert.ok(!out.message.includes(secret) && !out.stack.includes(secret), 'leaked ' + secret);
    }
    assert.ok(out.message.includes('https://docs.example.com/api/toc'), 'path kept for diagnosis');
    assert.ok(!out.message.includes('?token'), 'query string (token carrier) dropped');
  } finally {
    await browser.close();
    server.close();
  }
});
