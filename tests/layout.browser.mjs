import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Static layout evidence only: no extension APIs, network, or capture sessions.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const internal = path.join(root, 'internal');
const screenshots = path.join(root, 'docs');
await mkdir(internal, { recursive: true });
await mkdir(screenshots, { recursive: true });
process.env.TMPDIR = internal;
const html = (await readFile(path.join(root, 'extension/panel.html'), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const css = await readFile(path.join(root, 'extension/panel.css'), 'utf8');
const browser = await chromium.launch({
  channel: 'chromium',
  ...(process.env.MANUALDOCK_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE }
    : {}),
  headless: true,
  downloadsPath: internal,
  tracesDir: internal,
  env: { ...process.env, TMPDIR: internal },
});
const failures = [];
let scenarios = 0;

/** Build a static page with representative long source, status and content text. */
async function mount(viewport) {
  const page = await browser.newPage({ viewport });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    document.querySelector('#connection').textContent =
      '来源：https://device.example.com/documentation/security-platform/v6.0/administration-guide';
    document.querySelector('#source-url').value =
      'https://device.example.com/documentation/security-platform/v6.0/administration-guide';
    document
      .querySelector('#source-select')
      .replaceChildren(
        new Option(
          '安全管理平台 · 受控页面 · https://device.example.com/documentation/security-platform/v6.0/administration-guide',
          '1',
        ),
      );
    document.querySelector('#source-connect-status').textContent =
      '页面已连接，可以识别菜单和配置轮换。此消息用于验证很长的连接状态不会撑大工作区或遮挡操作。';
    document.querySelector('#product').value = '安全管理平台';
    document.querySelector('#version').value = '6.0.2';
    document.querySelector('#found').textContent = '128';
    document.querySelector('#captured').textContent = '46';
    document.querySelector('#remaining').textContent = '80';
    document.querySelector('#issues').textContent = '2';
    document.querySelector('#status').textContent = '正在采集 · 安全策略与访问控制';
    document.querySelector('#collection-message').hidden = false;
    document.querySelector('#collection-message').textContent =
      '查看详情 › 采集未完成：已离开手册范围，请检查登录或重新校准。1 章失败，4 章正文待核对。请查看来源页，必要时重新登录或校准，再继续。';
    document.querySelector('#retry-status').hidden = true;
    document.querySelector('#retry-status').textContent =
      '等待恢复 · 下次 13:42:10 · 已尝试 2 次 · 请在原标签页重新登录';
    document.querySelector('#directory-state').textContent = '128 个章节';
    document.querySelector('#article-state').textContent = '已定位';
    document.querySelector('#recognition-message').textContent =
      '识别完成，可开始采集。请核对预览是否包含所需的正文与表格。';
    document.querySelector('#preview').textContent =
      '# 安全策略配置\n\n本文说明如何创建访问控制策略，并通过日志核对实际生效情况。\n\n## 配置流程\n\n1. 在管理页面选择策略与对象。\n2. 设置源地址、目的地址及应用。\n3. 保存后检查规则匹配顺序。\n\n' +
      '配置项              说明\n源地址              需要访问的终端网段\n目的地址            业务服务器所在网段\n动作                允许访问并记录日志\n\n'.repeat(
        25,
      );
    document.querySelector('#diagnostics').textContent = JSON.stringify(
      { recognition: ['已找到目录及正文区域'], chapters: 128, warnings: ['两个章节需要复核'] },
      null,
      2,
    ).repeat(20);
    document.querySelector('#error-log').textContent =
      '2026/10/11 13:42:10  capture · 安全策略\n读取超时，请检查原标签页是否仍保持登录。\n\n'.repeat(
        20,
      );
    document.querySelector('#error').textContent =
      '原页面登录已失效，请在对应的手册标签页重新登录后重试。已保存内容保留，尚未完成的章节会继续处理。';
    document.querySelector('#rotation-status').textContent =
      '正在轮换 · 最近点击：安全策略管理 · 累计 12 次';
    document.querySelector('#batch-status').textContent =
      '3 个来源 · 2 个正在采集 · 1 个等待重新登录';
    document.querySelector('#sync-status').textContent =
      '本地保存已更新 · 128 个任务，可按产品或来源搜索。';
    document.querySelector('#samples').textContent = 'A：安全策略配置；B：日志审计与事件分析';
    document.querySelector('#profile-status').textContent = '两个示例验证通过，规则已保存。';
    document
      .querySelectorAll('button:not(.tab-radio)')
      .forEach((button) => (button.disabled = false));
  });
  return page;
}

/** Select modes and CSS-only tabs without importing or exercising application code. */
async function select(
  page,
  {
    mode = 'rotation',
    operation = 'collect',
    view = 'preview',
    error = false,
    dialog = '',
    spec = 'local',
  },
) {
  await page.evaluate(
    ({ mode, operation, view, error, dialog, spec }) => {
      document.querySelectorAll('dialog[open]').forEach((el) => el.close());
      document.querySelector('.app').dataset.currentMode = mode;
      document
        .querySelectorAll('[data-mode]')
        .forEach((el) => el.toggleAttribute('aria-current', el.dataset.mode === mode));
      document.querySelectorAll('[data-mode]').forEach((el) => {
        if (el.dataset.mode === mode) el.setAttribute('aria-current', 'page');
      });
      document
        .querySelectorAll('[data-panel]')
        .forEach((el) => (el.hidden = el.dataset.panel !== mode));
      document.querySelector('#document-meta').hidden = !['web', 'spec'].includes(mode);
      document
        .querySelectorAll('[data-operation]')
        .forEach((el) =>
          el.setAttribute('aria-selected', String(el.dataset.operation === operation)),
        );
      document
        .querySelectorAll('[data-operation-panel]')
        .forEach((el) => (el.hidden = el.dataset.operationPanel !== operation));
      document
        .querySelectorAll('[data-view]')
        .forEach((el) => el.setAttribute('aria-selected', String(el.dataset.view === view)));
      document
        .querySelectorAll('[data-view-panel]')
        .forEach((el) => (el.hidden = el.dataset.viewPanel !== view));
      document.querySelector('#error').hidden = !error;
      document.querySelector(`#spec-${spec}-tab`).checked = true;
      if (dialog) {
        document.querySelector(`#calibration-${dialog}-tab`).checked = true;
        document.querySelector('#calibration-dialog').showModal();
      }
    },
    { mode, operation, view, error, dialog, spec },
  );
  await populateLists(page);
}

/** Simulate pagination using the available height and a maximum of two visible rows. */
async function populateLists(page) {
  await page.evaluate(() => {
    const narrow = innerWidth <= 700;
    const setups = [
      [
        'chapters',
        'chapter-page',
        48,
        '<li class="chapter-item" data-status="captured"><span class="chapter-state">已保存</span><span class="chapter-title">安全策略与访问控制：跨区域业务系统访问限制与配置说明</span></li>',
      ],
      [
        'task-list',
        'library-page',
        narrow ? 128 : 112,
        '<li class="task-item"><button class="task-open"><span>安全管理平台 · 6.0.2</span><span>在线手册 · 已保存 128/128 章 · 已处理发现章节</span><span>来源 https://device.example.com/documentation/administration-guide</span><span>更新 2026/10/11 13:42 · 创建 2026/10/10</span></button><div class="task-actions"><button class="quiet">导出 JSON</button><button class="quiet danger">删除</button></div></li>',
      ],
      [
        'batch-list',
        'batch-page',
        narrow ? 146 : 122,
        '<li class="batch-item"><div class="batch-title">安全管理平台 · 管理员使用手册</div><div class="batch-source">https://device.example.com/documentation/administration-guide</div><div class="batch-progress">正在采集 · 已保存 46 / 128 章 · 需核对 2 章</div><div class="batch-error">读取超时，等待重新登录后继续</div><div class="batch-actions"><button class="batch-current">记录当前章</button><button class="batch-start primary">采集整本</button><button class="batch-pause">暂停</button><button class="batch-select">查看</button><button class="batch-remove">移除</button></div></li>',
      ],
      [
        'rotation-targets',
        'rotation-page',
        48,
        '<li><span>安全策略与访问控制配置</span><button>移除</button></li>',
      ],
    ];
    for (const [id, pager, rowHeight, markup] of setups) {
      const el = document.getElementById(id);
      if (!el.getClientRects().length) continue;
      const rows = Math.min(2, Math.max(1, Math.floor(el.clientHeight / rowHeight)));
      el.innerHTML = markup.repeat(rows);
      document.getElementById(pager).textContent = `1 / ${Math.ceil(128 / rows)} 页 · 共 128 项`;
    }
  });
}

/** Check viewport bounds and clipping ancestors for all visible controls and list rows. */
async function inspect(page, label) {
  scenarios++;
  const errors = await page.evaluate(() => {
    const issues = [];
    const visible = (el) =>
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    for (const el of [
      document.documentElement,
      document.body,
      document.querySelector('.app'),
      document.querySelector('.operations'),
    ]) {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        issues.push(
          `${el.className || el.tagName}: overflow ${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight}`,
        );
    }
    const openDialog = document.querySelector('dialog[open]');
    for (const el of document.querySelectorAll(
      'button,.file-trigger,.tab-label,.paginated-list>li,#retry-status,#recognition-message,#spec-status,#rotation-status,#profile-status,#source-url,#source-select,#source-connect-status,#connection',
    )) {
      if (!visible(el) || (openDialog && !openDialog.contains(el))) continue;
      const rect = el.getBoundingClientRect();
      const name = el.id || el.className || el.textContent.trim().slice(0, 20);
      if (
        rect.left < -1 ||
        rect.top < -1 ||
        rect.right > innerWidth + 1 ||
        rect.bottom > innerHeight + 1
      )
        issues.push(
          `${name}: outside viewport (${Math.round(rect.left)},${Math.round(rect.top)})..(${Math.round(rect.right)},${Math.round(rect.bottom)})`,
        );
      for (
        let ancestor = el.parentElement;
        ancestor && ancestor !== document.body;
        ancestor = ancestor.parentElement
      ) {
        // A modal dialog is in the browser top layer and escapes ancestor clipping.
        if (openDialog && !openDialog.contains(ancestor)) break;
        const style = getComputedStyle(ancestor);
        if (!/(hidden|clip|auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY))
          continue;
        const bounds = ancestor.getBoundingClientRect();
        if (
          rect.left < bounds.left - 1 ||
          rect.right > bounds.right + 1 ||
          rect.top < bounds.top - 1 ||
          rect.bottom > bounds.bottom + 1
        )
          issues.push(`${name}: clipped by ${ancestor.id || ancestor.className}`);
      }
    }
    for (const el of document.querySelectorAll('.paginated-list')) {
      if (visible(el) && el.children.length && el.scrollHeight > el.clientHeight + 1)
        issues.push(`${el.id}: rows exceed list height ${el.scrollHeight} > ${el.clientHeight}`);
    }
    return [...new Set(issues)];
  });
  failures.push(...errors.map((error) => `${label}: ${error}`));
}

try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1280, height: 600 },
    { width: 760, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page = await mount(viewport);
    const size = `${viewport.width}x${viewport.height}`;
    const defaults = await page.evaluate(() => ({
      mode: document.querySelector('.app').dataset.currentMode,
      firstMode: document.querySelector('.mode-nav [data-mode]').dataset.mode,
      activeMode: document.querySelector('.mode-nav [aria-current="page"]').dataset.mode,
      visiblePanels: [...document.querySelectorAll('[data-panel]')]
        .filter((el) => !el.hidden)
        .map((el) => el.dataset.panel),
    }));
    assert.deepEqual(defaults, {
      mode: 'rotation',
      firstMode: 'rotation',
      activeMode: 'rotation',
      visiblePanels: ['rotation'],
    });
    const alertText = await page.locator('#error').textContent();
    await page.locator('#error').evaluate((element) => {
      element.textContent = '';
      element.hidden = false;
    });
    assert.equal(
      await page.locator('#error').isVisible(),
      false,
      size + ' empty alert must occupy no space',
    );
    await page.locator('#error').evaluate((element, text) => {
      element.textContent = text;
      element.hidden = true;
    }, alertText);
    await populateLists(page);
    await inspect(page, `${size} default-rotation`);
    for (const error of [false, true]) {
      for (const mode of ['batch', 'library', 'rotation', 'spec']) {
        await select(page, { mode, error });
        await inspect(page, `${size} ${mode} error=${error}`);
      }
      await select(page, { mode: 'spec', spec: 'remote', error });
      await inspect(page, `${size} spec-remote error=${error}`);
      for (const operation of ['collect', 'identify']) {
        for (const view of ['preview', 'chapters', 'diagnostics', 'errors']) {
          await select(page, { mode: 'web', operation, view, error });
          await inspect(page, `${size} web/${operation}/${view} error=${error}`);
        }
      }
    }
    for (const dialog of ['basic', 'advanced']) {
      await select(page, { mode: 'web', operation: 'identify', dialog, error: true });
      await inspect(page, `${size} calibration-${dialog}`);
    }
    for (const mode of ['batch', 'web', 'library', 'rotation']) {
      await select(page, { mode });
      await page.screenshot({ path: path.join(screenshots, `test-layout-${size}-${mode}.png`) });
    }
    if (viewport.width === 390) {
      await select(page, { mode: 'web', operation: 'identify', dialog: 'advanced' });
      await page.screenshot({
        path: path.join(screenshots, `test-layout-${size}-calibration.png`),
      });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ scenarios, failures }, null, 2));
assert.equal(failures.length, 0, `${failures.length} layout failures`);
