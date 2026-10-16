/** Pure export rendering: sanitized saved pages in, four file strings out. No browser I/O. */
const DEFAULT_ENTRY = '未指定';
const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  captured: '已采集',
  review: '待核对',
  failed: '失败',
  waiting_login: '等待登录',
  interrupted: '已中断',
};
const COMPLETENESS_NOTE =
  '本档案仅包含已发现并保存的章节，无法确认全册完整。请对照设备上的真实目录核验。';

import { validateLocator } from './sangfor-rules.js';
import { chapterKey } from './sangfor-rules.js';

function string(value, fallback = '') {
  return value == null || String(value).trim() === '' ? fallback : String(value);
}

function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function escapeMarkdown(value) {
  return escapeHTML(value)
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

function pick(source, names) {
  const result = {};
  for (const name of names) if (source?.[name] !== undefined) result[name] = source[name];
  return result;
}

function archiveFor(job) {
  // Explicit fields exclude browser authentication storage and unrelated caller metadata.
  return {
    schemaVersion: job.schemaVersion === 2 ? 2 : 1,
    ...pick(job, [
      'taskId',
      'profileId',
      'profileRevision',
      'profile',
      'sourceKind',
      'specVersion',
    ]),
    entry: string(job.entry, DEFAULT_ENTRY),
    product: string(job.product, '未知'),
    version: string(job.version, '未知'),
    createdAt: string(job.createdAt, '未知'),
    updatedAt: string(job.updatedAt, '未知'),
    status: string(job.status, '未知'),
    ...pick(job, ['scanAt', 'selector', 'sessionDiagnostics']),
    queue: (job.queue ?? []).map((item) =>
      pick(item, ['key', 'url', 'title', 'locator', 'status', 'error', 'seed']),
    ),
    pages: Object.fromEntries(
      Object.entries(job.pages ?? {}).map(([url, page]) => [
        url,
        pick(page, [
          'status',
          'url',
          'title',
          'text',
          'markdown',
          'html',
          'links',
          'warnings',
          'diagnostics',
          'navigationProof',
          'hash',
          'capturedAt',
        ]),
      ]),
    ),
    discoveryWarnings: Array.isArray(job.discoveryWarnings) ? job.discoveryWarnings : [],
    scanDiagnostics: job.scanDiagnostics ?? {},
    coverageNote: COMPLETENESS_NOTE,
  };
}

function pageHasBody(page) {
  return (
    page?.status === 'ok' &&
    [page.text, page.markdown, page.html].some((value) => typeof value === 'string' && value.trim())
  );
}

/** Known sanitized empty disclosure shell, not a guess from a title in prose.
 * Does not classify arbitrary dialogs or missing/unloaded content as complete.
 */
export function hasMissingExamples(page) {
  return /<div>\s*<div>\s*<span>\s*<\/span>\s*(?:请求样例|返回样例(?:\s*<span>[^<]*<\/span>)?)\s*<\/div>\s*<\/div>/u.test(
    page?.html || '',
  );
}

function markdownBody(page, anchor) {
  const source = string(page.markdown, escapeHTML(string(page.text)));
  let fence = null;
  let tableDepth = 0;
  const decodeAttribute = (value) =>
    value.replace(
      /&(amp|quot|lt|gt|#39);/g,
      (_, entity) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[entity],
    );
  const attribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return decodeAttribute(match?.[1] ?? match?.[2] ?? '');
  };
  // Capture emits complex tables as sanitized HTML blocks. Preserve that table
  // structure, replacing actual images with HTML links; fenced examples stay exact.
  return source
    .split('\n')
    .map((line) => {
      const marker = !tableDepth && line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
          fence = null;
        return line;
      }
      if (fence) return line;
      if (tableDepth || /^\s*<table\b/i.test(line)) {
        return line.replace(/<\/?(?:table|img)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
          if (/^<table\b/i.test(tag)) {
            tableDepth += 1;
            return tag;
          }
          if (/^<\/table\b/i.test(tag)) {
            tableDepth = Math.max(0, tableDepth - 1);
            return tag;
          }
          if (!tableDepth || !/^data:image\//i.test(attribute(tag, 'src'))) return tag;
          const label = attribute(tag, 'alt') || '未命名图片';
          return `<a href="offline.html#${anchor}">[图片：${escapeHTML(label)}，见离线 HTML]</a>`;
        });
      }
      // Inline image data also stays in offline.html, keeping Markdown small.
      return line.replace(
        /!\[([^\]]*)\]\(\s*<?data:image\/[^\s)>]+>?(?:\s+"[^"]*")?\s*\)/gi,
        (_, label) =>
          `[图片：${escapeMarkdown(label || '未命名图片')}，见离线 HTML](offline.html#${anchor})`,
      );
    })
    .join('\n');
}

/**
 * Builds four UTF-8 text files: manual.md, offline.html, archive.json and report.txt.
 * Trust boundary: pages[*].html/markdown must be the sanitized output of capture.js,
 * never raw device HTML. Capture removes executable elements, handlers, forms, remote
 * resource URLs and unsafe links. This layer escapes all metadata and adds a restrictive
 * offline CSP; that CSP is defense in depth, not a replacement for capture sanitization.
 */
export function buildExports(job = {}) {
  const archive = archiveFor(job);
  const records = archive.queue.map((item, index) => {
    const page = archive.pages[chapterKey(item)];
    const hasBody = pageHasBody(page);
    const renderable = hasBody && ['captured', 'review'].includes(item.status);
    return {
      ...item,
      page,
      hasBody,
      renderable,
      source: page?.url || item.url,
      directoryPath:
        (job.schemaVersion === 2 &&
        Array.isArray(item.locator?.path) &&
        item.locator.path.every((p) => typeof p === 'string')
          ? item.locator.path.join(' > ')
          : validateLocator(item.locator)?.path.join(' > ')) || '',
      anchor: `chapter-${index + 1}`,
      title: string(item.title, string(page?.title, `未命名章节 ${index + 1}`)),
    };
  });
  const captured = records.filter((item) => item.status === 'captured' && item.hasBody);
  const reviews = records.filter((item) => item.status === 'review');
  const unresolved = records.filter(
    (item) =>
      !['captured', 'review'].includes(item.status) ||
      (item.status === 'captured' && !item.hasBody),
  );
  const warnings = [...archive.discoveryWarnings.map((value) => `目录：${string(value)}`)];
  for (const record of records) {
    if (hasMissingExamples(record.page))
      warnings.push(
        `${record.title}：样例只有标题，正文未保存；请在来源任务点击“重试问题项”补采。重新导出不能补回缺失内容。`,
      );
    for (const warning of record.page?.warnings ?? [])
      warnings.push(`${record.title}：${string(warning)}`);
    if (['captured', 'review'].includes(record.status) && !record.hasBody)
      warnings.push(`${record.title}：正文缺失或保存结果无效`);
  }
  const metadata = [
    `产品：${archive.product}`,
    `版本：${archive.version}`,
    `来源入口：${archive.entry}`,
    `创建时间：${archive.createdAt}`,
    `更新时间：${archive.updatedAt}`,
    `任务状态：${archive.status}`,
  ];
  const summary = [
    `目录记录：${records.length}`,
    `已采集正文：${captured.length}`,
    `待核对：${reviews.length}`,
    `待处理或失败：${unresolved.length}`,
  ];
  const label = (record) =>
    record.status === 'captured' && !record.hasBody
      ? '正文缺失'
      : (STATUS_LABELS[record.status] ?? string(record.status, '待处理'));
  const provenance = (record) =>
    `${record.source}${record.directoryPath ? ` | 目录路径：${record.directoryPath}` : ''}`;
  const report = [
    '手册采集报告',
    '',
    ...metadata,
    '',
    ...summary,
    '',
    COMPLETENESS_NOTE,
    '',
    '待核对章节：',
    ...(reviews.length
      ? reviews.map(
          (record) =>
            `- ${record.title} | ${provenance(record)} | ${string(record.error, '需要人工核对；不计入已采集正文')}`,
        )
      : ['无']),
    '',
    '待处理和失败章节：',
    ...(unresolved.length
      ? unresolved.map(
          (record) =>
            `- [${label(record)}] ${record.title} | ${provenance(record)}${record.error ? ` | ${record.error}` : ''}`,
        )
      : ['无']),
    '',
    '警告：',
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ['无']),
    ...(archive.sessionDiagnostics
      ? [
          '',
          '会话维护记录（请求成功不代表设备已续期）：',
          JSON.stringify(archive.sessionDiagnostics, null, 2),
        ]
      : []),
    '',
    '目录顺序：',
    ...(records.length
      ? records.map(
          (record, index) =>
            `${index + 1}. [${label(record)}] ${record.title} | ${provenance(record)}`,
        )
      : ['尚无目录记录']),
    '',
  ].join('\n');
  const markdown = [
    '# 手册采集档案',
    '',
    ...metadata.map((value) => `${escapeMarkdown(value)}  `),
    '',
    ...summary.map(escapeMarkdown),
    '',
    COMPLETENESS_NOTE,
    '',
    '## 目录',
    '',
    ...(records.length
      ? records.map(
          (record, index) =>
            `${index + 1}. ${escapeMarkdown(record.title)}（${escapeMarkdown(label(record))}）`,
        )
      : ['尚无目录记录。']),
    '',
    '## 正文',
    '',
    ...(records.some((record) => record.renderable) ? [] : ['尚无已保存的正文。']),
    ...records
      .filter((record) => record.renderable)
      .flatMap((record) => [
        `### ${escapeMarkdown(record.title)}${record.status === 'review' ? '（待核对，不计入已采集）' : ''}`,
        '',
        `来源：${escapeMarkdown(record.source)}  `,
        ...(record.directoryPath ? [`目录路径：${escapeMarkdown(record.directoryPath)}  `] : []),
        `保存时间：${escapeMarkdown(string(record.page.capturedAt, '未知'))}  `,
        `正文 SHA\-256：${escapeMarkdown(string(record.page.hash, '未知'))}`,
        '',
        ...(record.status === 'review'
          ? [`核对原因：${escapeMarkdown(string(record.error, '正文需要人工核对'))}`, '']
          : []),
        markdownBody(record.page, record.anchor),
        '',
      ]),
    '## 采集说明',
    '',
    '图片保存在 [离线 HTML](offline.html) 中。完整状态和章节数据见 archive.json，失败及待处理记录见 report.txt。',
    '',
    ...warnings.map((warning) => `- ${escapeMarkdown(warning)}`),
    '',
  ].join('\n');
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>手册采集档案</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 24px;color:#1f2937}h1,h2,h3{line-height:1.3}article{border-top:1px solid #d1d5db;margin-top:32px;padding-top:16px}pre{overflow:auto;padding:16px;background:#f3f4f6;white-space:pre-wrap}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #d1d5db;padding:8px}.notice,.review{background:#fff7df;padding:12px}.meta{color:#4b5563;overflow-wrap:anywhere}a{color:#1d4ed8}li{overflow-wrap:anywhere}</style></head><body>
<h1>手册采集档案</h1><div class="meta">${metadata.map((value) => `<div>${escapeHTML(value)}</div>`).join('')}</div>
<p>${summary.map(escapeHTML).join(' · ')}</p><p class="notice">${escapeHTML(COMPLETENESS_NOTE)}</p>
<nav aria-label="已发现目录"><h2>目录</h2><ol>${records.map((record) => `<li>${record.renderable ? `<a href="#${record.anchor}">${escapeHTML(record.title)}</a>` : escapeHTML(record.title)}（${escapeHTML(label(record))}）</li>`).join('') || '<li>尚无目录记录</li>'}</ol></nav>
<main>${
    records
      .filter((record) => record.renderable)
      .map(
        (record) => `<article id="${record.anchor}"><h2>${escapeHTML(record.title)}</h2>
${record.status === 'review' ? `<p class="review">待核对，不计入已采集：${escapeHTML(string(record.error, '正文需要人工核对'))}</p>` : ''}
<p class="meta">来源：${escapeHTML(record.source)}${record.directoryPath ? `<br>目录路径：${escapeHTML(record.directoryPath)}` : ''}<br>保存时间：${escapeHTML(string(record.page.capturedAt, '未知'))}<br>正文 SHA-256：${escapeHTML(string(record.page.hash, '未知'))}</p>
${string(record.page.html, `<pre>${escapeHTML(string(record.page.text, record.page.markdown))}</pre>`)}</article>`,
      )
      .join('') || '<p>尚无已保存的正文。</p>'
  }</main>
<section><h2>采集报告</h2><pre>${escapeHTML(report)}</pre></section></body></html>`;
  return { markdown, html, json: JSON.stringify(archive, null, 2), report };
}
