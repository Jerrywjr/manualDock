(() => {
  'use strict';

  const KIND = 'sangfor-ext-tree';
  const MAX_ROWS = 50000;
  const MAX_LEAVES = 5000;
  const MAX_PATH = 12;
  const MAX_TITLE = 200;
  const EXCLUDED = 'form,input,textarea,select,option,pre,code,script,style,template,[contenteditable]:not([contenteditable="false"])';
  const space = value => String(value || '').replace(/\s+/g, ' ').trim();
  const keyOf = path => JSON.stringify(path);
  const direct = (element, selector) => [...element.children].filter(child => child.matches(selector));

  // A DOM index is local to its siblings. It is deliberately never read here.
  function scope(entry) {
    const valid = raw => {
      if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^\/(?:adocs|cdocs)\.php$/.test(url.pathname)) return null;
      const pairs = [...url.searchParams];
      if (!pairs.length) return url.hash ? null : url;
      if (pairs.length !== 2 || url.searchParams.getAll('index').length !== 1 || url.searchParams.getAll('dataID').length !== 1) return null;
      return /^\d+$/.test(url.searchParams.get('index')) && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('dataID')) ? url : null;
    };
    try {
      const base = valid(entry);
      const actual = valid(location.href);
      return base && actual && base.origin === actual.origin && base.pathname === actual.pathname ? `${base.origin}${base.pathname}` : null;
    } catch { return null; }
  }

  function textOf(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(EXCLUDED)) return '';
    return [...node.childNodes].map(textOf).join('');
  }

  function rowTitle(row) {
    const labels = direct(row, 'span').filter(element => !element.classList.contains('x-tree-node-indent'));
    return space(labels.length ? labels.map(textOf).join(' ') : [...row.childNodes].filter(node => node.nodeType === 3).map(node => node.nodeValue).join(' '));
  }

  function observedNodeId(row, li) {
    const value = row.getAttribute('ext:tree-node-id') || li.getAttribute('ext:tree-node-id') || '';
    return /^api-menu-item\d+$/.test(value) ? value : undefined;
  }

  function inspect(entry) {
    const diagnostics = { kind: KIND, scope: 'current-top-document', roots: 0, rows: 0, leaves: 0,
      branches: 0, pendingBranches: 0, incompleteNodes: 0, ambiguousPaths: 0,
      unsupportedFrames: 0, truncated: false, limits: { rows: MAX_ROWS, leaves: MAX_LEAVES } };
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
    if (diagnostics.unsupportedFrames) warnings.push('目录树当前只扫描顶层文档；iframe/frame 内的目录尚未扫描，不能确认目录完整。');
    const roots = [...document.querySelectorAll('ul.x-tree-root-ct')].filter(root =>
      !root.closest(EXCLUDED) && !root.parentElement?.closest('ul.x-tree-root-ct'));
    diagnostics.roots = roots.length;
    const work = [];
    for (const root of [...roots].reverse()) {
      for (const li of direct(root, 'li.x-tree-node').reverse()) work.push({ li, path: [], ancestors: [] });
    }
    while (work.length) {
      if (diagnostics.rows >= MAX_ROWS) { diagnostics.truncated = true; break; }
      const { li, path, ancestors } = work.pop();
      if (li.closest(EXCLUDED)) continue;
      const rows = direct(li, '.x-tree-node-el');
      if (rows.length !== 1) { diagnostics.incompleteNodes++; continue; }
      const row = rows[0];
      diagnostics.rows++;
      const wrapper = row.classList.contains('x-tree-root');
      const title = rowTitle(row);
      if (!wrapper && (!title || title.length > MAX_TITLE)) { diagnostics.incompleteNodes++; continue; }
      const currentPath = wrapper ? path : [...path, title];
      if (currentPath.length > MAX_PATH) { diagnostics.incompleteNodes++; continue; }
      const containers = direct(li, 'ul.x-tree-node-ct');
      const children = containers.flatMap(container => direct(container, 'li.x-tree-node'));
      const branchControl = direct(row, '.x-tree-ec-icon.tree-has-child')[0] || null;
      const record = { li, row, path: currentPath, ancestors, container: containers[0], branchControl, leaf: false };
      if (!wrapper) {
        const key = keyOf(currentPath);
        if (records.has(key)) duplicates.add(key);
        else records.set(key, record);
      }
      if (containers.length !== 1) diagnostics.incompleteNodes++;
      if (children.length) {
        diagnostics.branches++;
        for (const child of children.reverse()) work.push({ li: child, path: currentPath, ancestors: wrapper ? ancestors : [...ancestors, record] });
      } else if (branchControl || wrapper) {
        diagnostics.pendingBranches++;
      } else if (containers.length === 1) {
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
      if (result.items.length >= MAX_LEAVES) { diagnostics.truncated = true; continue; }
      const locator = { kind: KIND, path: record.path };
      if (record.nodeId) locator.nodeId = record.nodeId;
      result.items.push({ url: canonical, title: record.path.at(-1), locator });
    }
    if (diagnostics.pendingBranches) warnings.push(`有 ${diagnostics.pendingBranches} 个目录分支尚未加载子项，请展开后重新扫描。`);
    if (diagnostics.incompleteNodes) warnings.push(`有 ${diagnostics.incompleteNodes} 个目录节点结构不完整或标题路径超出上限，已跳过，需人工核对。`);
    if (duplicates.size) warnings.push(`有 ${duplicates.size} 条目录标题路径重复，已排除歧义章节。`);
    if (diagnostics.truncated) warnings.push('目录达到扫描或章节数量上限，结果不完整；为避免定位歧义，未允许自动点击。');
    if (!roots.length) warnings.push('未找到受支持的 Ext 目录树。');
    return { result, records, duplicates };
  }

  function locate(state, locator) {
    if (locator?.kind !== KIND || !Array.isArray(locator.path) || !locator.path.length || locator.path.length > MAX_PATH ||
      locator.path.some(title => typeof title !== 'string' || !title || title.length > MAX_TITLE || title !== space(title)) ||
      (locator.nodeId !== undefined && !/^api-menu-item\d+$/.test(locator.nodeId))) return { reason: 'invalid-locator' };
    if (state.result.diagnostics.reason) return { reason: state.result.diagnostics.reason };
    if (state.result.diagnostics.truncated) return { reason: 'incomplete-scan' };
    const key = keyOf(locator.path);
    if (state.duplicates.has(key)) return { reason: 'ambiguous-path' };
    const record = state.records.get(key);
    if (!record?.leaf) return { reason: 'locator-not-found' };
    if (locator.nodeId && record.nodeId !== locator.nodeId) return { reason: 'node-id-mismatch' };
    return { record };
  }

  function resolve(entry, locator) { return locate(inspect(entry), locator); }

  function scan({ entry } = {}) { return inspect(entry).result; }

  function locallyHidden(element) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility);
  }

  function open({ entry, locator } = {}) {
    // Scan the whole tree once. The target leaf already being located proves
    // every ancestor is present and expanded in the current DOM, so the loop
    // below rarely needs to click, and when it does the tree handler may rebuild
    // nodes — in that case we re-scan once before reading the next ancestor.
    let located = locate(inspect(entry), locator);
    if (!located.record) return { clicked: false, reason: located.reason };
    const priorURL = location.href;
    const selectedBefore = located.record.row.classList.contains('x-tree-selected');
    const ancestorCount = located.record.ancestors.length;
    for (let i = 0; i < ancestorCount; i++) {
      const ancestor = located.record.ancestors[i];
      if (ancestor?.branchControl && locallyHidden(ancestor.container)) {
        ancestor.branchControl.click();
        located = locate(inspect(entry), locator);
        if (!located.record) return { clicked: false, reason: located.reason };
      }
    }
    const { row } = located.record;
    const label = direct(row, 'span').find(element => !element.classList.contains('x-tree-node-indent') && space(textOf(element))) || row;
    if (!row.isConnected || label.closest(EXCLUDED)) return { clicked: false, reason: 'locator-not-found' };
    // The caller waits for selection, URL/content updates, and reloads. This
    // call only performs the normal manual-directory click and returns at once.
    label.click();
    return { clicked: true, path: [...locator.path], title: locator.path.at(-1), priorURL, selectedBefore };
  }

  function rowForNodeId(nodeId) {
    if (!/^api-menu-item\d+$/.test(nodeId)) return null;
    let rows;
    try { rows = document.querySelectorAll('[ext\\:tree-node-id="' + nodeId + '"]'); } catch { return null; }
    if (rows.length !== 1) return null;
    const node = rows[0];
    const row = node.matches('.x-tree-node-el') ? node : direct(node, '.x-tree-node-el')[0] || node.closest('.x-tree-node-el');
    return row && row.isConnected ? row : null;
  }

  // The controller polls this while waiting for a chapter, so verifying must stay
  // cheap: a full tree scan on a large manual can consume the whole wait window.
  // The observed node id is unique in the document, so one lookup plus the row
  // title proves which row is meant. Anything ambiguous returns null and the
  // caller falls back to a complete scan instead of guessing.
  function quickVerify(locator) {
    const row = rowForNodeId(locator?.nodeId);
    if (!row) return null;
    if (rowTitle(row) !== locator.path.at(-1)) return null;
    return Boolean(row.classList.contains('x-tree-selected'));
  }

  function verify({ entry, locator } = {}) {
    const path = Array.isArray(locator?.path) ? [...locator.path] : [];
    const quick = path.length ? quickVerify(locator) : null;
    if (quick !== null) return { kind: KIND, path, verified: quick, reason: quick ? 'selected-path-matches' : 'selected-path-mismatch' };
    const located = resolve(entry, locator);
    const verified = Boolean(located.record?.row.classList.contains('x-tree-selected'));
    return { kind: KIND, path, verified,
      reason: verified ? 'selected-path-matches' : located.reason || 'selected-path-mismatch' };
  }

  globalThis.SangforTree = Object.freeze({ scan, open, verify });
})();
