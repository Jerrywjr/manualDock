import {
  validateProfile,
  cleanChapter,
  jobKey,
  ruleSignature,
  specificationURL,
  specificationTaskId,
  normalizeDocumentURL,
} from './profiles.js';
import { contentHash } from './core.js';
import { redact } from './recovery.js';

const MAX_BYTES = 128 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message) => {
  throw new Error(message);
};
const escapeHTML = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const warnings = (value) =>
  Array.isArray(value)
    ? value
        .filter((x) => typeof x === 'string')
        .slice(0, 1000)
        .map((x) => redact(x).slice(0, 1000))
    : [];
const timestamp = (value) =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
const metadata = (value, fallback) =>
  typeof value === 'string' && value.length <= 512
    ? value || fallback
    : fail('档案元数据格式或长度无效');
const sensitive =
  /(?:password|passwd|secret|token|authorization|cookie|session|credential|ticket|csrf|api[_-]?key|^sid$|^jwt$)/i;
const allowed = new Set(
  'a article section div p span h1 h2 h3 h4 h5 h6 pre code blockquote br hr b strong i em u s del mark sub sup ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr td th details summary img'.split(
    ' ',
  ),
);
const removed = new Set(
  'script style iframe frame frameset object embed form input textarea select option button link meta base svg math noscript template video audio source canvas'.split(
    ' ',
  ),
);

function safeLink(raw, base) {
  if (typeof raw !== 'string' || /[\u0000-\u0020\\]/.test(raw)) return null;
  if (/^#[A-Za-z0-9_.:-]+$/.test(raw)) return raw;
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some((key) => sensitive.test(key))) return null;
    const start = url.hash.search(/[?&]/);
    if (
      start !== -1 &&
      [...new URLSearchParams(url.hash.slice(start + 1)).keys()].some((key) => sensitive.test(key))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function rasterImage(raw) {
  if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024) return null;
  const match = raw.match(
    /^data:image\/(png|jpeg|gif|webp|bmp|x-icon|vnd.microsoft.icon);base64,([A-Za-z0-9+/]+={0,2})$/i,
  );
  if (!match) return null;
  try {
    const bytes = atob(match[2].slice(0, 64));
    const valid = {
      png: bytes.startsWith('\x89PNG\r\n\x1a\n'),
      jpeg: bytes.startsWith('\xff\xd8\xff'),
      gif: /^GIF8[79]a/.test(bytes),
      webp: bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP',
      bmp: bytes.startsWith('BM'),
      'x-icon': bytes.startsWith('\x00\x00\x01\x00'),
      'vnd.microsoft.icon': bytes.startsWith('\x00\x00\x01\x00'),
    };
    return valid[match[1].toLowerCase()] ? raw : null;
  } catch {
    return null;
  }
}
function sanitizeHTML(html, base, Parser) {
  // Parse into a template so untrusted resource elements stay inert even before
  // sanitization. Only freshly created allowlisted elements leave the template.
  const doc = new Parser().parseFromString(
    '<!doctype html><html><body></body></html>',
    'text/html',
  );
  const template = doc.createElement('template');
  template.innerHTML = html;
  const output = doc.createElement('div');
  let count = 0,
    images = 0;
  function append(node, parent, depth) {
    if (++count > 200000 || depth > 100) fail('档案正文结构超过恢复上限');
    if (node.nodeType === 3) {
      parent.append(doc.createTextNode(node.nodeValue || ''));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.localName.toLowerCase();
    if (removed.has(tag)) return;
    if (!allowed.has(tag)) {
      for (const child of node.childNodes) append(child, parent, depth + 1);
      return;
    }
    const el = doc.createElement(tag);
    if (tag === 'img') {
      const src = rasterImage(node.getAttribute('src'));
      if (!src) return;
      el.setAttribute('src', src);
      images++;
      el.setAttribute('alt', (node.getAttribute('alt') || '').slice(0, 1000));
    }
    if (tag === 'a') {
      const href = safeLink(node.getAttribute('href'), base);
      if (href) {
        el.setAttribute('href', href);
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    const id = node.getAttribute('id');
    if (id && /^[A-Za-z_][\w:.-]{0,199}$/.test(id)) el.setAttribute('id', id);
    const title = node.getAttribute('title');
    if (title) el.setAttribute('title', title.slice(0, 1000));
    for (const name of ['colspan', 'rowspan'])
      if (['td', 'th'].includes(tag) && /^[1-9]\d{0,2}$/.test(node.getAttribute(name) || ''))
        el.setAttribute(name, node.getAttribute(name));
    if (tag === 'ol' && /^-?\d{1,6}$/.test(node.getAttribute('start') || ''))
      el.setAttribute('start', node.getAttribute('start'));
    if (tag === 'th' && ['row', 'col', 'rowgroup', 'colgroup'].includes(node.getAttribute('scope')))
      el.setAttribute('scope', node.getAttribute('scope'));
    parent.append(el);
    for (const child of node.childNodes) append(child, el, depth + 1);
  }
  for (const node of template.content.childNodes) append(node, output, 0);
  return { html: output.innerHTML, text: output.textContent || '', images };
}
function sanitizeMarkdown(markdown, base) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
          fence = null;
        return line;
      }
      if (fence) return line;
      // Raw HTML is displayed literally in restored Markdown. Fenced examples are
      // already literal, so keep them exact; HTML tables remain in page.html.
      return line
        .replace(/[<>]/g, escapeHTML)
        .replace(
          /(!?)\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g,
          (_all, image, label, url) => {
            const safe = image ? rasterImage(url) : safeLink(url, base);
            return safe ? `${image}[${label}](${safe})` : label;
          },
        )
        .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        .replace(/!\[([^\]]*)\](?!\()/g, '$1')
        .replace(/^( {0,3}\[[^\]]+\]:\s*)(\S+)/, (_all, prefix, url) => {
          const safe = safeLink(url, base);
          return safe ? prefix + safe : prefix + '#removed';
        });
    })
    .join('\n');
}
function identity(raw) {
  const product = metadata(raw.product, '未知'),
    version = metadata(raw.version, '未知');
  if (raw.sourceKind === 'web') {
    if (
      !object(raw.profile) ||
      typeof raw.profile.id !== 'string' ||
      !raw.profile.id ||
      !Number.isSafeInteger(raw.profile.revision) ||
      raw.profile.revision < 1
    )
      fail('档案配置身份无效');
    const profile = validateProfile(raw.profile);
    if (
      raw.profileId !== profile.id ||
      raw.profileRevision !== profile.revision ||
      raw.profile.origin !== profile.origin ||
      raw.entry !== profile.entry ||
      raw.taskId !== jobKey(profile, product, version)
    )
      fail('档案任务身份与手册配置不一致');
    return {
      product,
      version,
      profile,
      profileId: profile.id,
      profileRevision: profile.revision,
      entry: profile.entry,
      taskId: raw.taskId,
      sourceKind: 'web',
    };
  }
  if (raw.sourceKind !== 'openapi') fail('档案来源格式不受支持');
  let parts;
  try {
    parts = JSON.parse(raw.taskId);
  } catch {
    fail('规范档案任务身份无效');
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 5 ||
    parts[0] !== 'spec' ||
    typeof parts[1] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parts[2]) ||
    raw.taskId !== specificationTaskId(parts[2], parts[1], product, version)
  )
    fail('规范档案任务身份无效');
  const source = parts[1];
  if (source.startsWith('file:')) {
    if (!source.slice(5) || raw.entry !== '本地文件:' + source.slice(5))
      fail('本地规范档案来源身份不一致');
  } else if (raw.entry !== source || specificationURL(source, source) !== source)
    fail('规范档案来源范围无效');
  if (
    typeof raw.specVersion !== 'string' ||
    !/^(?:2\.0|3\.[01]\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(raw.specVersion)
  )
    fail('规范档案版本无效');
  return {
    product,
    version,
    taskId: raw.taskId,
    entry: raw.entry,
    sourceKind: 'openapi',
    specVersion: raw.specVersion,
  };
}
function chapterOf(raw, task) {
  if (!object(raw)) fail('档案章节格式无效');
  if (task.sourceKind === 'web') {
    const chapter = cleanChapter(raw, task.profile);
    if (!chapter || chapter.key !== raw.key) fail('档案章节身份或手册范围无效');
    return chapter;
  }
  if (
    typeof raw.key !== 'string' ||
    !/^api:(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE):\/[^\u0000-\u001f\u007f]*$/.test(
      raw.key,
    ) ||
    raw.key.length > 2000 ||
    typeof raw.title !== 'string' ||
    raw.title.length > 2000 ||
    typeof raw.url !== 'string'
  )
    fail('规范档案章节身份无效');
  const fragment = '#' + encodeURIComponent(raw.key);
  if (!raw.url.endsWith(fragment)) fail('规范档案章节来源身份不一致');
  const base = raw.url.slice(0, -fragment.length);
  if (
    task.entry.startsWith('本地文件:') ? !/^urn:openapi:[^#\s]+$/.test(base) : base !== task.entry
  )
    fail('规范档案章节来源范围无效');
  return { key: raw.key, url: raw.url, title: raw.title };
}

/** Restores inert local data only. No network, tab binding, or navigation proof. */
export async function parseArchive(text, { DOMParser = globalThis.DOMParser } = {}) {
  if (
    typeof text !== 'string' ||
    text.length > MAX_BYTES ||
    new TextEncoder().encode(text).length > MAX_BYTES
  )
    fail('档案大小超过 128 MiB 或内容不是文本');
  if (typeof DOMParser !== 'function') fail('恢复正文需要 DOMParser 解析器');
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    fail('档案不是有效的 JSON');
  }
  if (!object(raw) || raw.schemaVersion !== 2) fail('仅支持 schemaVersion 2 档案格式');
  if (
    !Array.isArray(raw.queue) ||
    raw.queue.length > 5000 ||
    !object(raw.pages) ||
    Object.keys(raw.pages).length > 5000
  )
    fail('档案目录或正文数量无效（上限 5000 章）');
  const now = new Date().toISOString();
  const task = {
    schemaVersion: 2,
    ...identity(raw),
    createdAt: timestamp(raw.createdAt) || now,
    updatedAt: now,
    status: 'paused',
    queue: [],
    pages: Object.create(null),
    discoveryWarnings: warnings(raw.discoveryWarnings),
    scanDiagnostics: { source: 'archive' },
    autoRecovery: { enabled: false },
    origin: 'restored',
    restoredAt: now,
  };
  task.discoveryWarnings.push(
    '从本地档案恢复；已重算正文哈希，未重新验证网站内容或导航证明，自动恢复已关闭',
  );
  const known = new Set();
  for (const item of raw.queue) {
    const chapter = chapterOf(item, task);
    if (known.has(chapter.key)) fail('档案包含重复章节 key');
    known.add(chapter.key);
    chapter.status = ['captured', 'review', 'failed', 'pending'].includes(item.status)
      ? item.status
      : 'pending';
    if (typeof item.error === 'string') chapter.error = redact(item.error).slice(0, 1000);
    task.queue.push(chapter);
  }
  for (const key of Object.keys(raw.pages)) if (!known.has(key)) fail('档案正文不属于已验证目录');
  for (const chapter of task.queue) {
    const page = raw.pages[chapter.key];
    if (object(page) && typeof page.url === 'string') {
      const allowedURL =
        task.sourceKind === 'web'
          ? normalizeDocumentURL(page.url, task.profile)
          : page.url === chapter.url && page.url;
      if (
        !allowedURL ||
        (task.sourceKind === 'web' && !chapter.locator && allowedURL !== chapter.url)
      )
        fail('档案正文地址超出章节来源范围');
    }
    if (object(page) && page.status === 'ok') {
      const text = typeof page.text === 'string' ? page.text : '';
      const sanitized = sanitizeHTML(
        typeof page.html === 'string' ? page.html : '',
        chapter.url,
        DOMParser,
      );
      const markdown = sanitizeMarkdown(
        typeof page.markdown === 'string' ? page.markdown : '',
        chapter.url,
      );
      if (text.trim() || markdown.trim() || sanitized.text.trim() || sanitized.images) {
        const restored = {
          status: 'ok',
          key: chapter.key,
          url: typeof page.url === 'string' ? page.url : chapter.url,
          title: chapter.title,
          text,
          markdown,
          html: sanitized.html,
          links: [],
          warnings: warnings(page.warnings),
          diagnostics: {
            source: task.sourceKind === 'openapi' ? 'openapi' : 'archive',
            images: { embedded: sanitized.images },
          },
          origin: 'restored',
          restoredAt: now,
        };
        if (sanitized.html !== (page.html || ''))
          restored.warnings.push('恢复时重新清理了正文 HTML；仅保留静态格式、安全链接与内嵌位图');
        if (task.sourceKind === 'openapi') {
          const [, method, ...path] = chapter.key.split(':');
          Object.assign(restored.diagnostics, {
            specVersion: task.specVersion,
            method,
            path: path.join(':'),
          });
        }
        const capturedAt = timestamp(page.capturedAt);
        if (capturedAt) restored.capturedAt = capturedAt;
        restored.hash = await contentHash(text.trim() ? text : sanitized.html || markdown);
        task.pages[chapter.key] = restored;
      }
    }
    if (!own(task.pages, chapter.key) && ['captured', 'review'].includes(chapter.status)) {
      chapter.status = 'pending';
      delete chapter.error;
      task.discoveryWarnings.push(`章节「${chapter.title}」正文缺失或无效，已恢复为待处理`);
    }
  }
  if (task.queue.length && task.queue.every((c) => ['captured', 'review'].includes(c.status)))
    task.status = 'finished';
  return task;
}

/** Incoming must be the result of parseArchive; existing is the locally loaded task. */
export function mergeArchive(existing, incoming) {
  if (!existing)
    return {
      task: structuredClone(incoming),
      addedPages: Object.keys(incoming.pages).length,
      conflicts: [],
    };
  if (
    existing.taskId !== incoming.taskId ||
    existing.sourceKind !== incoming.sourceKind ||
    existing.entry !== incoming.entry ||
    (existing.sourceKind === 'web' &&
      ruleSignature(existing.profile) !== ruleSignature(incoming.profile))
  )
    fail('不能合并不同任务身份或手册范围的档案');
  const task = structuredClone(existing),
    conflicts = [];
  let addedPages = 0;
  const chapters = new Map(task.queue.map((c) => [c.key, c]));
  for (const chapter of incoming.queue) {
    let local = chapters.get(chapter.key);
    if (!local) {
      if (task.queue.length >= 5000) fail('合并后目录超过 5000 章');
      local = structuredClone(chapter);
      task.queue.push(local);
      chapters.set(local.key, local);
    }
    const page = incoming.pages[chapter.key];
    if (!page) continue;
    const saved = task.pages[chapter.key];
    if (saved) {
      if (
        ['text', 'html', 'markdown'].some((field) => (saved[field] || '') !== (page[field] || ''))
      )
        conflicts.push(chapter.key);
      continue;
    }
    task.pages[chapter.key] = structuredClone(page);
    addedPages++;
    if (['captured', 'review'].includes(chapter.status)) {
      local.status = chapter.status;
      if (chapter.error) local.error = chapter.error;
      else delete local.error;
    }
  }
  task.discoveryWarnings = [
    ...new Set([...(task.discoveryWarnings || []), ...incoming.discoveryWarnings]),
  ];
  if (conflicts.length)
    task.discoveryWarnings.push(`档案有 ${conflicts.length} 章与本地正文不同，保留本地版本`);
  for (const chapter of task.queue)
    if (['processing', 'waiting_login'].includes(chapter.status)) chapter.status = 'pending';
  task.autoRecovery = { enabled: false };
  task.status =
    task.queue.length && task.queue.every((c) => ['captured', 'review'].includes(c.status))
      ? 'finished'
      : 'paused';
  task.updatedAt = new Date().toISOString();
  return { task, addedPages, conflicts };
}
