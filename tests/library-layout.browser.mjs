import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
// Layout plus the production library renderer/paginator, using local task data.
// No extension storage or source tabs are accessed.
process.env.TMPDIR = fileURLToPath(new URL('../internal/', import.meta.url));
await mkdir(process.env.TMPDIR, { recursive: true });
const html = (await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const css = await readFile(new URL('../extension/panel.css', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8');
const view = (
  await readFile(new URL('../extension/library-view.js', import.meta.url), 'utf8')
).replace(/^export /gm, '');
const renderer =
  view +
  '\n' +
  source.slice(
    source.indexOf('async function library()'),
    source.indexOf('async function importSpec('),
  );
const paginator = source.slice(
  source.indexOf('function listPageSize('),
  source.indexOf('function renderChapters('),
);
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  ...(process.env.MANUALDOCK_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE }
    : {}),
  downloadsPath: process.env.TMPDIR,
  env: { ...process.env, TMPDIR: process.env.TMPDIR },
});
const results = [];
try {
  for (const [width, height, minimum] of [
    [1280, 600, 2],
    [1280, 800, 4],
    [1920, 1080, 8],
    [760, 800, 2],
    [390, 844, 2],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.addStyleTag({ content: css });
    await page.evaluate(
      ({ renderer, paginator }) => {
        document.querySelector('.app').dataset.currentMode = 'library';
        document.querySelectorAll('[data-mode]').forEach((button) => {
          if (button.dataset.mode === 'library') button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        });
        document.querySelector('#document-meta').hidden = true;
        document
          .querySelectorAll('[data-panel]')
          .forEach((e) => (e.hidden = e.dataset.panel !== 'library'));
        const tasks = Array.from({ length: 20 }, (_, i) => ({
          taskId: String(i),
          product: '文档 ' + i,
          version: '1.0',
          sourceKind: 'web',
          entry: 'https://manual.example/docs/' + i,
          queue: [],
          updatedAt: new Date(2026, 0, i + 1).toISOString(),
        }));
        new Function(
          'tasks',
          `const $=id=>document.getElementById(id);let libraryRows=[],libraryPage=0;const listTasks=async()=>tasks,taskState=()=> '已暂停',stamp=()=> '2026/01/01',ago=()=> '1 天前';${paginator}\n${renderer}\nwindow.renderLibrary=library;window.nextLibrary=()=>{libraryPage++;return library()};window.searchLibrary=()=>{libraryPage=0;return library()};`,
        )(tasks);
      },
      { renderer, paginator },
    );
    await page.evaluate(() => window.renderLibrary());
    const inspect = () =>
      page.evaluate(() => {
        const list = document.getElementById('task-list'),
          bounds = list.getBoundingClientRect(),
          items = [...list.querySelectorAll('.task-item')];
        return {
          rows: items.length,
          listHeight: list.clientHeight,
          overflow: list.scrollHeight > list.clientHeight + 1,
          clipped: items.some((e) => {
            const r = e.getBoundingClientRect();
            return r.bottom > bounds.bottom + 1 || r.right > bounds.right + 1;
          }),
          pageOverflow: document.documentElement.scrollHeight > innerHeight + 1,
          first: items[0]?.textContent,
        };
      });
    const state = await inspect();
    results.push({ width, height, ...state });
    assert.ok(
      state.rows >= minimum,
      `${width}x${height}: expected at least ${minimum} records, got ${state.rows}`,
    );
    assert.equal(state.overflow || state.clipped || state.pageOverflow, false);
    await page.evaluate(() => window.nextLibrary());
    const next = await inspect();
    assert.notEqual(next.first, state.first);
    await page.locator('#library-search').fill('文档 19');
    await page.evaluate(() => window.searchLibrary());
    assert.equal((await inspect()).rows, 1);
    await page.locator('#library-search').fill('');
    await page.evaluate(() => window.searchLibrary());
    assert.equal((await inspect()).rows, state.rows);
    if (width === 1280 && height === 800)
      await page.screenshot({ path: process.env.TMPDIR + 'library-layout.png' });
    await page.close();
  }
} finally {
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}
