import { parseDocument } from './vendor/yaml.js';

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = (value) =>
  String(value ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const escapeHTML = (value) =>
  plain(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
// Descriptions are documentation text, never executable HTML or Markdown links.
const escapeMarkdown = (value) =>
  plain(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&');
const utf8Size = (value) => new TextEncoder().encode(value).length;
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;

export class SpecificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecificationError';
  }
}
const fail = (message) => {
  throw new SpecificationError(message);
};

function decode(text, warn) {
  if (typeof text !== 'string' || !text.trim()) fail('API 定义为空，请选择 JSON 或 YAML 文件。');
  if (text.length > MAX_INPUT || utf8Size(text) > MAX_INPUT)
    fail('API 定义超过 16 MiB，请拆分后导入。');
  const input = text.replace(/^\uFEFF/, '').trim();
  let value, format;
  try {
    if (/^[{[]/.test(input)) {
      try {
        value = JSON.parse(input);
        format = 'json';
      } catch {
        /* Flow-style YAML may also start with { or [. */
      }
    }
    if (!format) {
      const document = parseDocument(input, {
        version: '1.2',
        schema: 'core',
        uniqueKeys: true,
        strict: true,
        prettyErrors: true,
      });
      if (document.errors.length) throw document.errors[0];
      for (const warning of document.warnings) warn('YAML 解析提示：' + warning.message);
      value = document.toJS({ maxAliasCount: 50 });
      format = 'yaml';
    }
  } catch (error) {
    fail('无法解析 JSON/YAML API 定义：' + error.message);
  }
  if (!record(value)) fail('OpenAPI/Swagger 定义必须是包含 openapi 或 swagger 字段的对象。');
  // YAML aliases can make a graph, including actual object cycles. Preserve the
  // relationship as data rather than allowing JSON serialization to recurse.
  let nodes = 0;
  const active = new WeakMap();
  function copy(node, path, depth) {
    if (++nodes > 250000 || depth > 100) fail('API 定义结构过大或嵌套超过 100 层，请拆分后导入。');
    if (node === null || typeof node !== 'object') return node;
    if (active.has(node)) {
      warn('循环 YAML 别名已保留为引用：' + active.get(node));
      return { $yamlAlias: active.get(node) };
    }
    const result = Array.isArray(node) ? [] : Object.create(null);
    active.set(node, path);
    for (const [key, child] of Object.entries(node))
      result[key] = copy(
        child,
        path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'),
        depth + 1,
      );
    active.delete(node);
    return result;
  }
  return { data: copy(value, '#', 0), format };
}

function pointer(document, reference) {
  if (reference === '#') return document;
  if (!reference.startsWith('#/')) return undefined;
  let fragment;
  try {
    fragment = decodeURIComponent(reference.slice(2));
  } catch {
    return undefined;
  }
  let current = document;
  for (const token of fragment.split('/')) {
    if (/~(?:[^01]|$)/.test(token)) return undefined;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !own(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
// These fields hold literal instance data, where a business property called
// "$ref" is not a schema/reference instruction. Named maps may use these names.
const LITERAL_FIELDS = new Set(['example', 'default', 'enum', 'const', 'value']);
const NAMED_MAPS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  'encoding',
  '$defs',
  'definitions',
  'schemas',
  'responses',
  'requestBodies',
  'parameters',
  'headers',
  'links',
  'callbacks',
  'examples',
  'securitySchemes',
  'paths',
  'pathItems',
  'webhooks',
  'content',
  'scopes',
]);
function walkStructure(value, visit, kinds = new WeakMap()) {
  const rootKind = value && typeof value === 'object' ? kinds.get(value) || '' : '';
  const seen = new WeakSet(),
    pending = [
      { node: value, named: rootKind.startsWith('named:'), kind: rootKind, context: undefined },
    ];
  while (pending.length) {
    const { node, named, kind, context } = pending.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (kind) kinds.set(node, kind);
    const nextContext = visit(node, named, context) ?? context;
    for (const [key, child] of Object.entries(node)) {
      if (!named && !Array.isArray(node) && LITERAL_FIELDS.has(key)) continue;
      if (!named && key === 'examples' && (Array.isArray(child) || kind === 'response')) continue;
      if (child !== null && typeof child === 'object') {
        const childNamed = !named && NAMED_MAPS.has(key);
        const childKind = childNamed
          ? 'named:' + key
          : kind === 'named:responses'
            ? 'response'
            : kinds.get(child) || '';
        pending.push({ node: child, named: childNamed, kind: childKind, context: nextContext });
      }
    }
  }
}
function references(value, kinds) {
  const found = [];
  walkStructure(
    value,
    (node, named) => {
      if (!named)
        for (const field of ['$ref', '$dynamicRef'])
          if (typeof node[field] === 'string')
            found.push({ ref: node[field], node, dynamic: field === '$dynamicRef' });
    },
    kinds,
  );
  return found;
}
function referenceResolver(document, warn) {
  const scopes = new WeakMap(),
    scopeIDs = new WeakMap([[document, 0]]),
    anchors = new WeakMap(),
    kinds = new WeakMap();
  let nextScope = 1;
  walkStructure(
    document,
    (node, named, parentScope) => {
      const scope = !named && typeof node.$id === 'string' ? node : parentScope || document;
      scopes.set(node, scope);
      if (!scopeIDs.has(scope)) scopeIDs.set(scope, nextScope++);
      if (!anchors.has(scope)) anchors.set(scope, new Map());
      if (!named)
        for (const field of ['$anchor', '$dynamicAnchor'])
          if (typeof node[field] === 'string') {
            const names = anchors.get(scope),
              name = node[field];
            if (names.has(name) && names.get(name) !== node) {
              names.set(name, undefined);
              warn('内部锚点不唯一，未猜测目标：#' + name);
            } else if (!names.has(name)) names.set(name, node);
          }
      return scope;
    },
    kinds,
  );
  return {
    references: (value) => references(value, kinds),
    key: ({ ref, node }) => String(scopeIDs.get(scopes.get(node) || document)) + ':' + ref,
    resolve(ref, node) {
      const scope = scopes.get(node) || document;
      if (ref === '#' || ref.startsWith('#/')) return pointer(scope, ref);
      if (!ref.startsWith('#')) return undefined;
      try {
        return anchors.get(scope)?.get(decodeURIComponent(ref.slice(1)));
      } catch {
        return undefined;
      }
    },
  };
}
function dereference(resolver, value, warn, chain = new Set()) {
  if (!record(value) || typeof value.$ref !== 'string') return value;
  const ref = value.$ref,
    key = resolver.key({ ref, node: value });
  if (!ref.startsWith('#')) {
    warn('外部引用未读取：' + ref);
    return value;
  }
  if (chain.has(key)) {
    warn('循环引用已保留链接：' + ref);
    return value;
  }
  if (chain.size >= 100) fail('路径或参数的引用链超过 100 层，请拆分后导入。');
  const target = resolver.resolve(ref, value);
  if (target === undefined) {
    warn('内部引用未找到：' + ref);
    return value;
  }
  chain.add(key);
  const resolved = dereference(resolver, target, warn, chain);
  return record(resolved) ? { ...resolved, ...value } : value;
}
function parameters(resolver, inherited, operation, warn) {
  const found = new Map();
  for (const item of [
    ...(Array.isArray(inherited) ? inherited : []),
    ...(Array.isArray(operation) ? operation : []),
  ]) {
    if (!record(item)) {
      warn('忽略无效的参数定义。');
      continue;
    }
    const resolved = dereference(resolver, item, warn);
    const key =
      typeof resolved.name === 'string' && typeof resolved.in === 'string'
        ? JSON.stringify([resolved.in, resolved.name])
        : 'ref:' + (item.$ref ?? found.size);
    found.set(key, item);
  }
  return [...found.values()];
}
function safeJSON(value) {
  let size = 0,
    nodes = 0;
  const json = JSON.stringify(
    value,
    (key, item) => {
      size += key.length + (typeof item === 'string' ? item.length : 8);
      if (++nodes > 75000 || size > MAX_PAGE) fail('单项 API 定义过大，请拆分规范文件后导入。');
      return item;
    },
    2,
  );
  if (utf8Size(json) > MAX_PAGE) fail('单项 API 定义超过 2 MiB，请拆分后导入。');
  return json;
}
function sourceAddress(sourceURL, title, warn) {
  if (sourceURL) {
    try {
      if (typeof sourceURL !== 'string' || sourceURL.length > 16384) throw new Error();
      const url = new URL(sourceURL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      url.hash = '';
      return url.href;
    } catch {
      warn('来源地址无效或含认证信息，已改用本地文档标识。');
    }
  }
  return 'urn:openapi:' + encodeURIComponent(title || 'document');
}

/** Pure, synchronous import: no browser DOM, script execution or network access. */
export function parseSpecification(text, options = {}) {
  const warnings = new Set(),
    warn = (message) => warnings.add(plain(message));
  const { data: specification, format } = decode(text, warn);
  if (own(specification, 'swagger') && own(specification, 'openapi'))
    fail('API 版本字段冲突：不能同时声明 swagger 和 openapi。');
  const specVersion = specification.swagger === '2.0' ? '2.0' : specification.openapi;
  if (!(
    specVersion === '2.0' ||
    (typeof specVersion === 'string' && /^3\.[01]\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(specVersion))
  ))
    fail('不支持的 API 格式或版本：需要 Swagger 2.0、OpenAPI 3.0 或 OpenAPI 3.1。');
  const info = record(specification.info) ? specification.info : {};
  const title = plain(options.product || info.title || options.filename || 'API 文档').slice(
    0,
    512,
  );
  const resolver = referenceResolver(specification, warn);
  const version = plain(options.version || info.version || '未知');
  const source = sourceAddress(options.sourceURL, title, warn);
  const pages = Object.create(null),
    queue = [];
  let outputSize = 0;
  const paths = record(specification.paths) ? specification.paths : {};
  if (!record(specification.paths)) warn('定义中没有有效的 paths 对象。');
  if (record(specification.webhooks) && Object.keys(specification.webhooks).length)
    warn('顶层 webhooks 没有请求路径，当前未单独生成章节；仅导入 paths 下的 HTTP 操作。');
  // Report even unused external references; never load a referenced resource.
  for (const { ref, node, dynamic } of resolver.references(specification)) {
    if (!ref.startsWith('#')) warn('外部引用未读取：' + ref);
    else if (resolver.resolve(ref, node) === undefined) warn('内部引用未找到：' + ref);
    if (dynamic) warn('动态引用仅链接本地声明，未计算验证时的动态作用域：' + ref);
  }
  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!path.startsWith('/')) {
      warn('忽略无效的 API 路径：' + path);
      continue;
    }
    const pathItem = dereference(resolver, rawPathItem, warn);
    if (!record(pathItem)) {
      warn('忽略无效的路径定义：' + path);
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue;
      if (!record(operation)) {
        warn('忽略无效的操作：' + method.toUpperCase() + ' ' + path);
        continue;
      }
      if (queue.length >= 5000) fail('API 操作超过 5000 个，请拆分后导入。');
      const upper = method.toUpperCase(),
        key = 'api:' + upper + ':' + path;
      const operationTitle =
        upper +
        ' ' +
        path +
        (operation.summary || operation.operationId
          ? ' · ' + plain(operation.summary || operation.operationId)
          : '');
      const url = source + '#' + encodeURIComponent(key);
      const pageWarnings = new Set(),
        pageWarn = (message) => {
          pageWarnings.add(plain(message));
          warn(message);
        };
      const effectiveParameters = parameters(
        resolver,
        pathItem.parameters,
        operation.parameters,
        pageWarn,
      );
      const security = own(operation, 'security') ? operation.security : specification.security;
      const schemas =
        specVersion === '2.0'
          ? specification.securityDefinitions
          : specification.components?.securitySchemes;
      const sections = [];
      const section = (heading, data) => {
        if (data !== undefined) sections.push({ heading, data });
      };
      section('文档信息', { ...info, title, version });
      section('操作参数（路径参数与操作参数合并）', effectiveParameters);
      section('请求体 requestBody', operation.requestBody);
      section('响应 responses', operation.responses);
      section(
        '认证要求 security',
        security === undefined ? { note: '规范未声明认证要求；不代表服务无需认证。' } : security,
      );
      section('认证方式定义', schemas);
      if (specVersion === '2.0')
        section('请求地址与媒体类型', {
          host: specification.host,
          basePath: specification.basePath,
          schemes: operation.schemes ?? specification.schemes,
          consumes: operation.consumes ?? specification.consumes,
          produces: operation.produces ?? specification.produces,
        });
      else
        section('服务器 servers', operation.servers ?? pathItem.servers ?? specification.servers);
      if (typeof rawPathItem?.$ref === 'string') section('路径引用', { $ref: rawPathItem.$ref });
      if (pathItem.summary || pathItem.description)
        section('路径说明', { summary: pathItem.summary, description: pathItem.description });
      section('完整操作定义', operation);
      const refs = new Map();
      function addReferences(data) {
        for (const reference of resolver.references(data)) {
          const { ref, node, dynamic } = reference,
            referenceKey = resolver.key(reference);
          if (refs.has(referenceKey)) continue;
          if (refs.size >= 1000) fail('单个操作的引用超过 1000 项，请拆分后导入。');
          const target = ref.startsWith('#') ? resolver.resolve(ref, node) : undefined;
          refs.set(referenceKey, {
            ref,
            target,
            id: 'openapi-op-' + (queue.length + 1) + '-ref-' + (refs.size + 1),
          });
          if (dynamic) pageWarn('动态引用仅链接本地声明，未计算验证时的动态作用域：' + ref);
          if (!ref.startsWith('#')) pageWarn('外部引用未读取：' + ref);
          else if (target === undefined) pageWarn('内部引用未找到：' + ref);
        }
      }
      for (const { data } of sections) addReferences(data);
      // Map iteration includes newly added references, so cycles terminate once
      // a reference has been seen while reachable definitions are retained.
      for (const { target } of refs.values()) if (target !== undefined) addReferences(target);
      const textParts = [],
        markdown = [],
        html = [];
      function writer(parts, separator) {
        let length = 0;
        return (...items) => {
          for (const item of items) {
            const added = utf8Size(item) + (parts.length ? separator.length : 0);
            if (length + added > MAX_PAGE || outputSize + added > MAX_OUTPUT)
              fail('生成的 API 文档过大（每种格式单页 2 MiB / 总计 64 MiB），请拆分后导入。');
            length += added;
            outputSize += added;
            parts.push(item);
          }
        };
      }
      const writeText = writer(textParts, '\n\n'),
        writeMarkdown = writer(markdown, '\n\n'),
        writeHTML = writer(html, '\n');
      writeText(operationTitle);
      writeMarkdown('# ' + escapeMarkdown(operationTitle));
      writeHTML('<article><h1>' + escapeHTML(operationTitle) + '</h1>');
      function paragraph(value) {
        if (!value) return;
        writeText(plain(value));
        writeMarkdown(escapeMarkdown(value));
        writeHTML('<p>' + escapeHTML(value).replace(/\n/g, '<br>') + '</p>');
      }
      paragraph(operation.description);
      if (Array.isArray(security) && !security.length)
        paragraph('本操作明确不要求认证（security: []）。');
      function renderSection(heading, data, id) {
        const json = safeJSON(data);
        let fenceLength = 3;
        for (const match of json.matchAll(/`+/g))
          fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = '`'.repeat(fenceLength);
        writeText(heading, json);
        writeMarkdown(
          (id ? '<a id="' + id + '"></a>\n\n' : '') + '## ' + escapeMarkdown(heading),
          fence + 'json\n' + json + '\n' + fence,
        );
        writeHTML(
          '<section><h2' +
            (id ? ' id="' + id + '"' : '') +
            '>' +
            escapeHTML(heading) +
            '</h2><pre><code>' +
            escapeHTML(json) +
            '</code></pre>',
        );
        for (const reference of resolver.references(data)) {
          const { ref } = reference,
            link = refs.get(resolver.key(reference));
          if (link?.target === undefined) continue;
          const label = '引用：' + ref;
          writeMarkdown('[' + escapeMarkdown(label) + '](#' + link.id + ')');
          writeHTML('<p><a href="#' + link.id + '">' + escapeHTML(label) + '</a></p>');
        }
        writeHTML('</section>');
      }
      for (const { heading, data } of sections) renderSection(heading, data);
      for (const { ref, target, id } of refs.values())
        if (target !== undefined) renderSection('引用定义 ' + ref, target, id);
      for (const warning of pageWarnings) paragraph('提示：' + warning);
      writeHTML('</article>');
      const page = {
        status: 'ok',
        url,
        title: operationTitle,
        text: textParts.join('\n\n'),
        markdown: markdown.join('\n\n'),
        html: html.join('\n'),
        links: [],
        warnings: [...pageWarnings],
        diagnostics: {
          source: 'openapi',
          specVersion,
          format,
          method: upper,
          path,
          operationId: plain(operation.operationId),
          referenceCount: refs.size,
          externalReferenceCount: [...refs.values()].filter(({ ref }) => !ref.startsWith('#'))
            .length,
        },
      };
      pages[key] = page;
      queue.push({ key, url, title: operationTitle, status: 'captured' });
    }
  }
  if (!queue.length) warn('没有发现可导入的 HTTP 操作。');
  return { title, version, pages, queue, warnings: [...warnings], specVersion };
}
