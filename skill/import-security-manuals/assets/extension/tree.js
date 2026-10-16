(() => {
  'use strict';

  const KIND = 'sangfor-ext-tree';
  const MAX_ROWS = 50000;
  const MAX_LEAVES = 5000;
  const MAX_PATH = 12;
  const MAX_TITLE = 200;
  const EXCLUDED =
    'form,input,textarea,select,option,pre,code,script,style,template,[contenteditable]:not([contenteditable="false"])';
  const space = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const keyOf = (path) => JSON.stringify(path);
  const direct = (element, selector) =>
    [...element.children].filter((child) => child.matches(selector));

  // A DOM index is local to its siblings. It is deliberately never read here.
  function scope(entry) {
    const valid = (raw) => {
      if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f\\]/.test(raw))
        return null;
      const url = new URL(raw);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !/^\/(?:adocs|cdocs)\.php$/.test(url.pathname)
      )
        return null;
      const pairs = [...url.searchParams];
      if (!pairs.length) return url.hash ? null : url;
      if (
        pairs.length !== 2 ||
        url.searchParams.getAll('index').length !== 1 ||
        url.searchParams.getAll('dataID').length !== 1
      )
        return null;
      return /^\d+$/.test(url.searchParams.get('index')) &&
        /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('dataID'))
        ? url
        : null;
    };
    try {
      const base = valid(entry);
      const actual = valid(location.href);
      return base && actual && base.origin === actual.origin && base.pathname === actual.pathname
        ? `${base.origin}${base.pathname}`
        : null;
    } catch {
      return null;
    }
  }

  function textOf(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(EXCLUDED)) return '';
    return [...node.childNodes].map(textOf).join('');
  }

  function rowLabels(row) {
    const spans = direct(row, 'span').filter(
      (element) => !element.classList.contains('x-tree-node-indent'),
    );
    if (spans.length) return spans;
    const anchors = direct(row, 'a.x-tree-node-anchor');
    return anchors.length > 1 ? null : anchors;
  }

  function rowTitle(row) {
    const labels = rowLabels(row);
    if (!labels) return '';
    return space(
      labels.length
        ? labels.map(textOf).join(' ')
        : [...row.childNodes]
            .filter((node) => node.nodeType === 3)
            .map((node) => node.nodeValue)
            .join(' '),
    );
  }

  function observedNodeId(row, li) {
    const value = row.getAttribute('ext:tree-node-id') || li.getAttribute('ext:tree-node-id') || '';
    return /^api-menu-item\d+$/.test(value) ? value : undefined;
  }

  // Ext tree grids share the navigation class but render parameter columns.
  // Require the widget's own structure, not merely a DIV tag or an empty tree.
  function inParameterGrid(element) {
    const grid = element.closest('.x-treegrid-ct');
    return Boolean(
      grid &&
      direct(grid, '.x-grid3-header').length === 1 &&
      direct(grid, '.x-treegrid-root-node').length === 1,
    );
  }

  // Explicit directory bindings may name one container or a set of Ext roots.
  // Only callers that omit a binding retain the legacy whole-document scan.
  function directoryRoots({ tocSelector } = {}) {
    const rootSelector = 'ul.x-tree-root-ct';
    let candidates;
    if (tocSelector === undefined) candidates = [...document.querySelectorAll(rootSelector)];
    else {
      if (typeof tocSelector !== 'string' || !tocSelector.trim() || tocSelector.length > 1000)
        throw new Error('目录定位规则无效，请重新校准');
      let matches;
      try {
        matches = [...document.querySelectorAll(tocSelector)];
      } catch {
        throw new Error('目录定位规则无效，请重新校准');
      }
      if (!matches.length) throw new Error('目录定位没有匹配区域，请重新校准');
      matches = matches.filter((node) => !node.closest(EXCLUDED) && !inParameterGrid(node));
      if (!matches.length) throw new Error('所选目录内没有受支持的树根，请重新校准');
      if (matches.length > 1) {
        if (!matches.every((node) => node.matches(rootSelector)))
          throw new Error('目录定位匹配多个普通区域，请重新校准');
        candidates = matches;
      } else {
        const container = matches[0];
        if (
          container.matches('html,body,main,article,[role="main"]') ||
          container.closest(EXCLUDED)
        )
          throw new Error('目录必须限定为独立导航区域，请重新校准');
        candidates = container.matches(rootSelector)
          ? [container]
          : [...container.querySelectorAll(rootSelector)];
      }
    }
    const roots = candidates.filter(
      (root) =>
        !root.closest(EXCLUDED) &&
        !inParameterGrid(root) &&
        !root.parentElement?.closest(rootSelector),
    );
    if (tocSelector !== undefined && !roots.length)
      throw new Error('所选目录内没有受支持的树根，请重新校准');
    return roots;
  }

  function inspect(entry, tocSelector) {
    const diagnostics = {
      kind: KIND,
      scope: tocSelector === undefined ? 'current-top-document' : 'configured-directory',
      roots: 0,
      rows: 0,
      leaves: 0,
      branches: 0,
      pendingBranches: 0,
      incompleteNodes: 0,
      ambiguousPaths: 0,
      unsupportedFrames: 0,
      truncated: false,
      limits: { rows: MAX_ROWS, leaves: MAX_LEAVES },
    };
    const warnings = [];
    const records = new Map();
    const duplicates = new Set();
    const result = { items: [], diagnostics, warnings };
    const canonical = scope(entry);
    if (!canonical) {
      diagnostics.reason = 'invalid-scope';
      warnings.push('当前地址不在合法的 adocs.php/cdocs.php 手册范围，未读取或点击目录。');
      return { result, records, duplicates };
    }
    diagnostics.unsupportedFrames = document.querySelectorAll('iframe,frame').length;
    if (diagnostics.unsupportedFrames)
      warnings.push('目录树当前只扫描顶层文档；iframe/frame 内的目录尚未扫描，不能确认目录完整。');
    let roots;
    try {
      roots = directoryRoots({ tocSelector });
    } catch (error) {
      diagnostics.reason = 'invalid-directory';
      result.status = 'error';
      result.error = error.message;
      warnings.push(error.message);
      return { result, records, duplicates };
    }
    diagnostics.roots = roots.length;
    const work = [];
    for (const root of [...roots].reverse()) {
      for (const li of direct(root, 'li.x-tree-node').reverse())
        work.push({ li, path: [], ancestors: [] });
    }
    while (work.length) {
      if (diagnostics.rows >= MAX_ROWS) {
        diagnostics.truncated = true;
        break;
      }
      const { li, path, ancestors } = work.pop();
      if (li.closest(EXCLUDED)) continue;
      const rows = direct(li, '.x-tree-node-el');
      if (rows.length !== 1) {
        diagnostics.incompleteNodes++;
        continue;
      }
      const row = rows[0];
      diagnostics.rows++;
      const wrapper = row.classList.contains('x-tree-root');
      const title = rowTitle(row);
      if (!wrapper && (!title || title.length > MAX_TITLE)) {
        diagnostics.incompleteNodes++;
        continue;
      }
      const currentPath = wrapper ? path : [...path, title];
      if (currentPath.length > MAX_PATH) {
        diagnostics.incompleteNodes++;
        continue;
      }
      const containers = direct(li, 'ul.x-tree-node-ct');
      const children = containers.flatMap((container) => direct(container, 'li.x-tree-node'));
      const branchControl = direct(row, '.x-tree-ec-icon.tree-has-child')[0] || null;
      const record = {
        li,
        row,
        path: currentPath,
        ancestors,
        container: containers[0],
        branchControl,
        leaf: false,
      };
      if (!wrapper) {
        const key = keyOf(currentPath);
        if (records.has(key)) duplicates.add(key);
        else records.set(key, record);
      }
      // A marked leaf may omit its empty child list. Missing containers on
      // unmarked nodes or nodes with pending/unknown children remain incomplete.
      const bareLeaf =
        containers.length === 0 &&
        row.classList.contains('x-tree-node-leaf') &&
        !branchControl &&
        !li.querySelector('ul,ol,.x-tree-node');
      if (containers.length !== 1 && !bareLeaf) diagnostics.incompleteNodes++;
      if (children.length) {
        diagnostics.branches++;
        for (const child of children.reverse())
          work.push({
            li: child,
            path: currentPath,
            ancestors: wrapper ? ancestors : [...ancestors, record],
          });
      } else if (branchControl || wrapper) {
        diagnostics.pendingBranches++;
      } else if (containers.length === 1 || bareLeaf) {
        record.leaf = true;
        record.nodeId = observedNodeId(row, li);
      }
    }
    diagnostics.ambiguousPaths = duplicates.size;
    // If the traversal limit was reached, an unseen row could duplicate a path.
    // Keep discovery useful but refuse opening any path until a complete scan.
    for (const [key, record] of records) {
      if (!record.leaf || duplicates.has(key)) continue;
      diagnostics.leaves++;
      if (result.items.length >= MAX_LEAVES) {
        diagnostics.truncated = true;
        continue;
      }
      const locator = { kind: KIND, path: record.path };
      if (record.nodeId) locator.nodeId = record.nodeId;
      result.items.push({ url: canonical, title: record.path.at(-1), locator });
    }
    if (diagnostics.pendingBranches)
      warnings.push(`有 ${diagnostics.pendingBranches} 个目录分支尚未加载子项，请展开后重新扫描。`);
    if (diagnostics.incompleteNodes)
      warnings.push(
        `有 ${diagnostics.incompleteNodes} 个目录节点结构不完整或标题路径超出上限，已跳过，需人工核对。`,
      );
    if (duplicates.size)
      warnings.push(`有 ${duplicates.size} 条目录标题路径重复，已排除歧义章节。`);
    if (diagnostics.truncated)
      warnings.push('目录达到扫描或章节数量上限，结果不完整；为避免定位歧义，未允许自动点击。');
    if (!roots.length) warnings.push('未找到受支持的 Ext 目录树。');
    return { result, records, duplicates };
  }

  function locate(state, locator) {
    if (
      locator?.kind !== KIND ||
      !Array.isArray(locator.path) ||
      !locator.path.length ||
      locator.path.length > MAX_PATH ||
      locator.path.some(
        (title) =>
          typeof title !== 'string' || !title || title.length > MAX_TITLE || title !== space(title),
      ) ||
      (locator.nodeId !== undefined && !/^api-menu-item\d+$/.test(locator.nodeId))
    )
      return { reason: 'invalid-locator' };
    if (state.result.diagnostics.reason)
      return { reason: state.result.error || state.result.diagnostics.reason };
    if (state.result.diagnostics.truncated) return { reason: 'incomplete-scan' };
    const key = keyOf(locator.path);
    if (state.duplicates.has(key)) return { reason: 'ambiguous-path' };
    const record = state.records.get(key);
    if (!record?.leaf) return { reason: 'locator-not-found' };
    if (locator.nodeId && record.nodeId !== locator.nodeId) return { reason: 'node-id-mismatch' };
    return { record };
  }

  function resolve(entry, locator, tocSelector) {
    return locate(inspect(entry, tocSelector), locator);
  }

  function scan({ entry, tocSelector } = {}) {
    return inspect(entry, tocSelector).result;
  }

  // Only what identifies a fault crosses the chrome.scripting.executeScript()
  // boundary: only what identifies a fault leaves the page. Secrets in
  // messages/stacks are stripped by redact() so credentials never reach the log.
  const SENSITIVE_KEY =
    /(?:token|api[_-]?key|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|authorization|auth|session[_-]?id|set[_-]?cookie|cookie)/i;
  const redact = (text) => {
    if (text == null) return text;
    let s = String(text);
    s = s.replace(/(https?:\/\/[^\s"'<>?#]+)(\?[^?\s"'<>]*)?(#[^\s"'<>]*)?/g, (m, base) => base);
    s = s.replace(/(Authorization\s*:\s*(?:Bearer\s+)?)\S+/gi, '$1<redacted>');
    s = s.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
    s = s.replace(/(?:Set-)?Cookie\s*:\s*\S+/gi, (m) => m.replace(/\S+$/, '<redacted>'));
    s = s.replace(
      new RegExp('(' + SENSITIVE_KEY.source + '\\s*[=:]\\s*)\\S+', 'gi'),
      '$1<redacted>',
    );
    return s;
  };
  const errShape = (e) =>
    e?.fault || {
      name: String(e?.name || 'Error'),
      message: redact(String(e?.message || e || '').slice(0, 500)),
      stack: redact(
        String(e?.stack || '')
          .split('\n')
          .slice(0, 8)
          .join('\n'),
      ).slice(0, 1200),
    };

  function locallyHidden(element) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
    // Visibility that cannot be determined must never be answered as "visible",
    // otherwise the caller keeps collecting from a row it never proved. Raise
    // instead, carrying the original error so it survives the script boundary.
    const view = element.ownerDocument?.defaultView;
    if (!view)
      throw Object.assign(new Error('无法读取目录行的显示状态：文档窗口不可用'), {
        fault: errShape(new Error('defaultView unavailable')),
      });
    let style;
    try {
      style = view.getComputedStyle(element);
    } catch (error) {
      throw Object.assign(new Error(error?.message || '无法读取目录行的显示状态'), {
        fault: errShape(error),
      });
    }
    return style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility);
  }

  function open({ entry, locator, tocSelector } = {}) {
    try {
      // Scan the whole tree once. The target leaf already being located proves
      // every ancestor is present and expanded in the current DOM, so the loop
      // below rarely needs to click, and when it does the tree handler may rebuild
      // nodes — in that case we re-scan once before reading the next ancestor.
      let located = locate(inspect(entry, tocSelector), locator);
      if (!located.record) return { clicked: false, reason: located.reason };
      const priorURL = location.href;
      const selectedBefore = located.record.row.classList.contains('x-tree-selected');
      const ancestorCount = located.record.ancestors.length;
      for (let i = 0; i < ancestorCount; i++) {
        const ancestor = located.record.ancestors[i];
        if (ancestor?.branchControl && locallyHidden(ancestor.container)) {
          ancestor.branchControl.click();
          located = locate(inspect(entry, tocSelector), locator);
          if (!located.record) return { clicked: false, reason: located.reason };
        }
      }
      const { row } = located.record;
      const label = rowLabels(row)?.find((element) => space(textOf(element))) || row;
      if (!row.isConnected || label.closest(EXCLUDED))
        return { clicked: false, reason: 'locator-not-found' };
      if (label.matches('a.x-tree-node-anchor')) {
        const target =
          label.getAttribute('target') ||
          label.ownerDocument.querySelector('base[target]')?.getAttribute('target') ||
          '_self';
        if (label.hasAttribute('download') || target.toLowerCase() !== '_self')
          return { clicked: false, reason: 'anchor-outside-source-tab' };
        const href = (label.getAttribute('href') || '').trim();
        // An anchor can navigate independently of its tree handler. Resolve its
        // actual base URL and target before allowing a click in this source tab.
        if (label.hasAttribute('href') && !/^javascript:\s*(?:void\(0\)|;?)\s*;?$/i.test(href)) {
          const destination = new URL(href, label.baseURI || location.href);
          const current = new URL(location.href);
          if (href === '#') {
            destination.hash = '';
            current.hash = '';
            if (destination.href !== current.href)
              return { clicked: false, reason: 'anchor-outside-manual' };
          } else if (!scope(destination.href))
            return { clicked: false, reason: 'anchor-outside-manual' };
        }
      }
      // The caller waits for selection, URL/content updates, and reloads. This
      // call only performs the normal manual-directory click and returns at once.
      label.click();
      return {
        clicked: true,
        path: [...locator.path],
        title: locator.path.at(-1),
        priorURL,
        selectedBefore,
      };
    } catch (error) {
      return {
        clicked: false,
        reason: error?.message || '无法打开所选章节',
        fault: errShape(error),
      };
    }
  }

  function rowForNodeId(nodeId, roots) {
    if (!/^api-menu-item\d+$/.test(nodeId)) return null;
    let rows;
    try {
      rows = roots.flatMap((root) => [
        ...root.querySelectorAll('[ext\\:tree-node-id="' + nodeId + '"]'),
      ]);
    } catch {
      return null;
    }
    if (rows.length !== 1) return null;
    const node = rows[0];
    const row = node.matches('.x-tree-node-el')
      ? node
      : direct(node, '.x-tree-node-el')[0] || node.closest('.x-tree-node-el');
    return row && row.isConnected ? row : null;
  }

  // Follow only matching title prefixes, but visit every matching branch so a
  // second node with the same complete path cannot hide behind a unique id.
  function uniquePathRow(root, path) {
    const work = direct(root, 'li.x-tree-node').map((li) => ({ li, index: 0 }));
    let found = null,
      visited = 0;
    while (work.length) {
      if (++visited > MAX_ROWS) return null;
      const { li, index } = work.pop();
      if (li.closest(EXCLUDED)) continue;
      const rows = direct(li, '.x-tree-node-el');
      if (rows.length !== 1) continue;
      const row = rows[0],
        wrapper = row.classList.contains('x-tree-root');
      if (!wrapper && rowTitle(row) !== path[index]) continue;
      const next = wrapper ? index : index + 1;
      if (!wrapper && next === path.length) {
        if (found) return null;
        found = row;
        continue;
      }
      for (const container of direct(li, 'ul.x-tree-node-ct'))
        for (const child of direct(container, 'li.x-tree-node'))
          work.push({ li: child, index: next });
    }
    return found;
  }

  // The controller polls this while waiting for a chapter, so verifying must stay
  // cheap: a full tree scan on a large manual can consume the whole wait window.
  // Within a single bound root, matching the entire ancestor path rejects a
  // rebuilt tree that reused the node id. Multiple roots need the full scan's
  // duplicate-path check even when a node id alone is unique.
  function quickVerify(locator, roots) {
    if (roots.length !== 1) return null;
    const row = rowForNodeId(locator?.nodeId, roots);
    if (!row) return null;
    if (locator?.kind !== KIND || !Array.isArray(locator.path) || locator.path.length > MAX_PATH)
      return null;
    const root = row.closest('ul.x-tree-root-ct');
    if (!roots.includes(root) || row.closest(EXCLUDED)) return null;
    const observed = [];
    for (
      let li = row.parentElement;
      li && root.contains(li);
      li = li.parentElement?.closest('li.x-tree-node')
    ) {
      const rows = direct(li, '.x-tree-node-el');
      if (rows.length !== 1) return null;
      if (!rows[0].classList.contains('x-tree-root')) observed.unshift(rowTitle(rows[0]));
    }
    if (keyOf(observed) !== keyOf(locator.path)) return null;
    if (uniquePathRow(root, locator.path) !== row) return null;
    return Boolean(row.classList.contains('x-tree-selected'));
  }

  function verify({ entry, locator, tocSelector } = {}) {
    const path = Array.isArray(locator?.path) ? [...locator.path] : [];
    if (!scope(entry)) return { kind: KIND, path, verified: false, reason: 'invalid-scope' };
    let roots;
    try {
      roots = directoryRoots({ tocSelector });
    } catch (error) {
      return { kind: KIND, path, verified: false, reason: error.message, fault: errShape(error) };
    }
    const quick = path.length ? quickVerify(locator, roots) : null;
    if (quick !== null)
      return {
        kind: KIND,
        path,
        verified: quick,
        reason: quick ? 'selected-path-matches' : 'selected-path-mismatch',
      };
    const located = resolve(entry, locator, tocSelector);
    const verified = Boolean(located.record?.row.classList.contains('x-tree-selected'));
    return {
      kind: KIND,
      path,
      verified,
      reason: verified ? 'selected-path-matches' : located.reason || 'selected-path-mismatch',
    };
  }

  function current({ entry, tocSelector } = {}) {
    const state = inspect(entry, tocSelector);
    if (state.result.diagnostics.reason || state.result.diagnostics.truncated)
      return { status: 'error', error: '目录范围无效或扫描不完整，不能唯一确认当前章节' };
    const selected = state.result.items.filter((item) =>
      state.records.get(keyOf(item.locator.path))?.row.classList.contains('x-tree-selected'),
    );
    if (selected.length !== 1)
      return { status: 'error', error: '无法唯一确认当前章节，请先在目录中选择章节' };
    return { status: 'ok', chapter: selected[0] };
  }

  globalThis.SangforTree = Object.freeze({ directoryRoots, scan, current, open, verify, rowTitle });
})();
