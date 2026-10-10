(() => {
  'use strict';

  const HTML_TAGS = new Set('a abbr article b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li main mark ol p pre s samp section small span strong sub summary sup table tbody td tfoot th thead tr u ul var'.split(' '));
  const DROP_TAGS = new Set('script style noscript template form input textarea select option button datalist output object embed applet svg math audio video source track link meta base canvas nav aside footer'.split(' '));
  const BLOCK_TAGS = new Set('article blockquote caption dd details div dl dt figcaption figure h1 h2 h3 h4 h5 h6 hr li main ol p pre section summary table tbody td tfoot th thead tr ul'.split(' '));
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_IMAGES = 40;
  const MAX_IMAGE_TIME = 4000;
  const MAX_TOTAL_IMAGE_TIME = 20000;
  const cleanSpace = value => String(value || '').replace(/\s+/g, ' ').trim();

  let activeProfile = null;
  function manualURL(raw, entry, base = entry) {
    if (activeProfile) return globalThis.SecurityManualAdapters.normalizeURL(raw, activeProfile, base);
    try {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().startsWith('#') || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
      const scope = new URL(entry);
      if (!['http:', 'https:'].includes(scope.protocol) || scope.username || scope.password) return null;
      const url = new URL(raw.trim().replace(/&amp;/gi, '&'), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== scope.origin || url.pathname !== scope.pathname || url.username || url.password) return null;
      const parameters = [...url.searchParams.entries()];
      if (!parameters.length) {
        if (url.hash) return null;
        url.search = '';
        return url.href;
      }
      if (parameters.length !== 2 || url.searchParams.getAll('index').length !== 1 || url.searchParams.getAll('dataID').length !== 1) return null;
      const index = url.searchParams.get('index');
      const dataID = url.searchParams.get('dataID');
      if (!/^\d+$/.test(index) || !/^[A-Za-z0-9_-]+$/.test(dataID)) return null;
      url.hash = '';
      url.search = `?index=${index.replace(/^0+(?=\d)/, '')}&dataID=${dataID}`;
      return url.href;
    } catch { return null; }
  }

  function displayURL(raw, entry) {
    const accepted = manualURL(raw, entry);
    if (accepted) return accepted;
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
    catch { return ''; }
  }

  // Only what identifies a fault crosses the chrome.scripting.executeScript()
  // boundary: never page content, form values, cookies or credentials.
  const errShape = e => e?.fault || ({ name: String(e?.name || 'Error'), message: String(e?.message || e || '').slice(0, 500),
    stack: String(e?.stack || '').split('\n').slice(0, 8).join('\n').slice(0, 1200) });
  let visibilityFaults = [];

  function hidden(element) {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;
    const style = element.getAttribute('style') || '';
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
    if (activeProfile && element.ownerDocument.defaultView) {
      try { const computed = element.ownerDocument.defaultView.getComputedStyle(element);
        if (computed.display === 'none' || ['hidden', 'collapse'].includes(computed.visibility)) return true;
      } catch (error) {
        // A live element whose visibility cannot be determined is not proven
        // visible, so it is excluded instead of being collected. The detached
        // sanitized output has no layout at all and keeps the old behaviour.
        if (element.isConnected) { visibilityFaults.push(errShape(error)); return true; }
      }
    }
    return false;
  }

  function excluded(element) {
    const tag = element.localName?.toLowerCase();
    if (DROP_TAGS.has(tag) || hidden(element)) return true;
    // Apply a calibrated TOC rule only to live source documents. Structural
    // selectors must not accidentally match a differently shaped output clone.
    if (activeProfile?.tocSelector && element.ownerDocument.defaultView) {
      try { if (element.closest(activeProfile.tocSelector)) return true; } catch { /* Invalid selectors are rejected by calibration. */ }
    }
    if (element.matches('.x-tree-root-ct, .x-tree-node-ct, .x-tree-node-el, [role="tree"], .ext-el-mask, .ext-el-mask-msg, .x-mask, .x-mask-msg')) return true;
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return true;
    if (['navigation', 'banner', 'contentinfo'].includes(element.getAttribute('role'))) return true;
    return tag === 'header' && !element.closest('main,article');
  }

  // Walk text nodes only after excluding active and form subtrees. Never read
  // body.textContent, input values, authentication storage, or script contents.
  function plainText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
    if (node.nodeType === 1 && excluded(node)) return '';
    const tag = node.localName?.toLowerCase();
    if (tag === 'br') return '\n';
    const text = [...node.childNodes].map(plainText).join('');
    return BLOCK_TAGS.has(tag) ? `\n${text}\n` : text;
  }

  function visibleControl(element) {
    for (let current = element; current; current = current.parentElement) {
      if (hidden(current)) return false;
      try {
        const style = current.ownerDocument.defaultView?.getComputedStyle(current);
        if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility)) return false;
      } catch { /* Inline visibility checks remain available. */ }
    }
    return true;
  }

  function loginPage(doc, address) {
    // A frame's own controls can appear visible while its embedding frame is
    // hidden. Check the entire frame chain before even accepting a login URL.
    for (let frame = doc.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
      if (!visibleControl(frame)) return false;
    }
    const loginRoute = value => {
      try {
        return /(?:^|\/)(?:login|logon|signin|sign-in|sso|authenticate|auth|session)(?:[./_-]|$)/i.test(new URL(value, address).pathname);
      } catch { return false; }
    };
    if (loginRoute(address)) return true;
    const loginButton = button => {
      // A submit input's static value attribute is its button label; credential
      // fields and every live input.value remain unread.
      const label = button.matches('input[type="submit"]')
        ? cleanSpace(button.getAttribute('value'))
        : cleanSpace([...button.childNodes].map(plainText).join(''));
      return visibleControl(button) && /^(?:(?:重新|再次)?登\s*[录入錄]|sign[ -]?in|log[ -]?in)(?:\s|$)/i.test(label);
    };
    const forms = [...doc.querySelectorAll('form')].some(form => {
      if (!visibleControl(form)) return false;
      const password = [...form.querySelectorAll('input[type="password"]')].find(visibleControl);
      if (!password) return false;
      const action = form.getAttribute('action') || '';
      // API examples and password settings also have password + submit controls.
      // Require a login action or login label, without reading credential values.
      const submit = [...form.querySelectorAll('button, input[type="submit"], [role="button"]')].some(loginButton);
      return submit || Boolean(action && loginRoute(action));
    });
    if (forms) return true;
    const password = [...doc.querySelectorAll('input[type="password"]')].find(input => !input.closest('form') && visibleControl(input));
    if (!password) return false;
    return [...doc.querySelectorAll('button, input[type="submit"], [role="button"]')].some(loginButton);
  }

  async function waitForDOM(doc, options) {
    const start = Date.now();
    let lastChange = start;
    let timeout;
    const observers = new Map();
    const observe = target => {
      if (!target.documentElement) return;
      let root = target.documentElement;
      if (activeProfile && !options.scanOnly) {
        try { root = selectRoot(target, target === doc ? options.selector : undefined).root || root; } catch { /* Invalid selectors are reported after waiting. */ }
      }
      if (observers.has(root)) return;
      lastChange = Date.now();
      const view = target.defaultView || globalThis;
      const observer = new view.MutationObserver(() => { lastChange = Date.now(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-src', 'hidden', 'aria-hidden', 'style', ...(activeProfile ? ['class', 'alt'] : [])] });
      observers.set(root, observer);
    };
    const hasContent = (target, seen = new Set(), depth = 0) => {
      if (seen.has(target) || depth > 5) return false;
      seen.add(target);
      observe(target);
      if (loginPage(target, target.URL)) return true;
      if (options.scanOnly && target.querySelector('[href], [data-href], [data-url], [onclick]')) return true;
      let selected;
      try { selected = selectRoot(target, activeProfile && target !== doc ? undefined : options.selector).root; } catch { return true; }
      let found = Boolean(selected && (cleanSpace(plainText(selected)) || selected.querySelector('img')));
      let pendingFrame = false;
      const frames = activeProfile ? selected?.querySelectorAll('iframe,frame') || [] : target.querySelectorAll('iframe,frame');
      for (const frame of frames) {
        if (!visibleControl(frame) || (activeProfile && excluded(frame))) continue;
        try {
          const child = frame.contentDocument;
          if (!child?.documentElement || !child.body) continue;
          const frameReady = hasContent(child, seen, depth + 1);
          if (frameReady) found = true;
          else pendingFrame = true;
        } catch { /* Cross-origin frames are diagnosed after settling. */ }
      }
      return found && !pendingFrame;
    };
    return new Promise(resolve => {
      const check = () => {
        const now = Date.now();
        const ready = doc.readyState !== 'loading' && hasContent(doc);
        const stable = ready && now - start >= 1200 && now - lastChange >= 500;
        if (stable || now - start >= 8000) {
          for (const observer of observers.values()) observer.disconnect();
          clearTimeout(timeout);
          resolve({ waitedMs: now - start, settled: Boolean(stable) });
        } else timeout = setTimeout(check, 75);
      };
      check();
    });
  }

  function collectDocuments(top, entry, warnings, diagnostics, selector) {
    const documents = [];
    const frameDocs = new Map();
    const seen = new Set();
    const visit = (doc, base, depth) => {
      if (seen.has(doc)) return;
      seen.add(doc);
      documents.push({ doc, base });
      const frameRoot = activeProfile ? selectRoot(doc, doc === top ? selector : undefined).root : doc;
      for (const frame of frameRoot?.querySelectorAll('iframe,frame') || []) {
        if (activeProfile && (!visibleControl(frame) || excluded(frame))) continue;
        diagnostics.frames += 1;
        if (depth >= 5) {
          diagnostics.inaccessibleFrames += 1;
          warnings.push('iframe 嵌套超过 5 层，未采集更深内容。');
          continue;
        }
        try {
          const src = frame.getAttribute('src') || '';
          const target = new URL(src || base, base);
          const blank = target.protocol === 'about:' && target.pathname === 'blank';
          if (!blank && target.origin !== new URL(entry).origin) throw new Error('cross-origin');
          const child = frame.contentDocument;
          if (!child?.documentElement || !child.body) throw new Error('unavailable');
          const childAddress = child.URL;
          if (childAddress && !childAddress.startsWith('about:') && new URL(childAddress).origin !== new URL(entry).origin) throw new Error('cross-origin');
          const childBase = blank || childAddress?.startsWith('about:') ? base : activeProfile && childAddress ? childAddress : target.href;
          frameDocs.set(frame, child);
          visit(child, childBase, depth + 1);
        } catch {
          diagnostics.inaccessibleFrames += 1;
          warnings.push('有 iframe 内容无法访问（跨源或尚未加载），此部分未采集。');
        }
      }
    };
    visit(top, top.URL, 0);
    return { documents, frameDocs };
  }

  function discover(documents, entry, diagnostics) {
    const found = new Map();
    for (const { doc, base } of documents) {
      for (const element of doc.querySelectorAll('[href], [data-href], [data-url], [onclick]')) {
        if (element.closest('script, style, form, input, textarea, select, [contenteditable="true"]')) continue;
        const raws = ['href', 'data-href', 'data-url'].map(name => element.getAttribute(name)).filter(Boolean);
        const handler = element.getAttribute('onclick');
        if (handler) {
          // Read only literal URL arguments. No eval, handler invocation, identifier
          // expansion, API calls, or script-element inspection is performed.
          const literals = [...handler.matchAll(/(['"])([^'"\r\n]*(?:adocs|cdocs)\.php(?:\?[^'"\r\n]*)?)\1/gi)].map(match => match[2]);
          raws.push(...literals);
          if (!literals.some(raw => manualURL(raw, entry, base))) diagnostics.unmappedHandlers += 1;
        }
        const title = cleanSpace(plainText(element)).slice(0, 200) || '未命名章节';
        for (const raw of raws) {
          const url = manualURL(raw, entry, base);
          if (url && !found.has(url)) found.set(url, { url, title });
        }
      }
    }
    diagnostics.linkCount = found.size;
    return [...found.values()];
  }


  // This snapshot describes observed DOM evidence only. It neither infers URLs
  // from IDs nor inspects registered callbacks, scripts, storage, or form values.
  function menuStructure(top, entry, warnings, diagnostics) {
    const limits = { nodes: 600, elements: 12000, documents: 30, depth: 80, frameDepth: 5, text: 120 };
    const snapshot = { schemaVersion: 1, scope: 'current-dom-only', eventListeners: 'unknown', limits,
      totalCandidates: 0, exportedCount: 0, visitedElements: 0, truncated: false,
      traversalTruncated: false, candidateCountIsLowerBound: false, nodes: [], documents: [] };
    const scope = new URL(entry);
    const found = new Map();
    const seen = new Set([top]);
    const fields = ['index', 'data-index', 'dataid', 'data-dataid', 'data-data-id'];
    const blockedTags = new Set('head script style noscript template form input textarea select option datalist output pre code object embed svg math canvas audio video'.split(' '));
    const menuRoles = new Set(['navigation', 'tree', 'menu', 'menubar', 'tablist', 'treeitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab']);
    const proseRoot = element => ['main', 'article'].includes(element.localName) || element.getAttribute('role') === 'main';
    const blocked = element => blockedTags.has(element.localName) ||
      (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false');
    const identity = element => ({ tag: element.localName,
      id: (element.getAttribute('id') || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
      class: cleanSpace(element.getAttribute('class')).slice(0, 200),
      role: cleanSpace(element.getAttribute('role')).slice(0, 60) });
    const framePath = raw => {
      try { const url = new URL(raw, entry); return url.origin === scope.origin ? `${url.origin}${url.pathname}` : 'about:blank'; }
      catch { return ''; }
    };
    const attributes = element => {
      const accepted = {}, rejected = [];
      for (const name of fields) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name) || '';
        const valid = name === 'index' || name === 'data-index' ? /^\d{1,20}$/.test(value) : /^[A-Za-z0-9_-]{1,120}$/.test(value);
        if (valid) accepted[name] = value;
        else rejected.push(name);
      }
      return { accepted, rejected };
    };
    const linkEvidence = (raw, base) => {
      if (raw.length > 1024) return { reason: 'too-long' };
      const url = manualURL(raw, entry, base);
      if (url) return { url };
      if (!raw.trim()) return { reason: 'empty' };
      if (raw.trim().startsWith('#')) return { reason: 'fragment-only' };
      try {
        const target = new URL(raw, base);
        if (!['http:', 'https:'].includes(target.protocol)) return { reason: 'unsafe-scheme' };
        if (target.username || target.password) return { reason: 'credentials' };
        if (target.origin !== scope.origin) return { reason: 'other-origin' };
        if (target.pathname !== scope.pathname) return { reason: 'other-path' };
        return { reason: 'unsupported-query' };
      } catch { return { reason: 'invalid-url' }; }
    };
    const handlerSummary = (element, base) => {
      const raw = element.getAttribute('onclick');
      const summary = { present: raw !== null, calls: [], manualURLs: [], truncated: Boolean(raw && raw.length > 2048) };
      if (!raw) return summary;
      if (raw.includes('`')) return { ...summary, unsupportedSyntax: 'template-literal' };
      const safeLiterals = new Map();
      let literalIndex = 0;
      // Mask strings, templates and comments before identifying call names. Only
      // whole, unescaped manual URLs and narrowly allowed navigation arguments survive.
      const code = raw.slice(0, 2048).replace(/'(?:\\.|[^'\\])*(?:'|$)|"(?:\\.|[^"\\])*(?:"|$)|`(?:\\.|[^`\\])*(?:`|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g, literal => {
        if (literal.startsWith('/')) return ' ';
        const quote = literal[0];
        if (quote !== '`' && literal.endsWith(quote) && !literal.includes('\\')) {
          const evidence = linkEvidence(literal.slice(1, -1), base);
          if (evidence.url && summary.manualURLs.length < 8 && !summary.manualURLs.includes(evidence.url)) summary.manualURLs.push(evidence.url);
        }
        const marker = `__string_${literalIndex++}__`;
        const value = literal.slice(1, -1);
        if (literal.endsWith(quote) && /^api-menu-item\d{1,12}$/.test(value)) safeLiterals.set(marker, value);
        return marker;
      });
      // A slash outside masked strings/comments can introduce a regex literal.
      // Leave such complex source unmapped rather than exposing literal contents.
      if (code.includes('/')) return summary;
      const calls = code.matchAll(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g);
      for (const match of calls) {
        if (summary.calls.length >= 12) { summary.truncated = true; break; }
        if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(match[1])) continue;
        const parts = [];
        let level = 0, start = match.index + match[0].length;
        for (let pos = start; pos < code.length; pos++) {
          const character = code[pos];
          if (character === ')' && level === 0) { if (code.slice(start, pos).trim()) parts.push(code.slice(start, pos)); break; }
          if ('([{'.includes(character)) level++;
          if (')]}'.includes(character)) level--;
          if (character === ',' && level === 0) { parts.push(code.slice(start, pos)); start = pos + 1; }
          if (parts.length >= 10) { summary.truncated = true; break; }
        }
        const argumentTypes = parts.map(part => {
          const value = part.trim();
          if (/^__string_\d+__$/.test(value)) return 'string';
          if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return 'number';
          if (/^(?:true|false)$/.test(value)) return 'boolean';
          if (value === 'null') return 'null';
          return 'expression';
        });
        const name = match[1].replace(/\s+/g, '').slice(0, 80);
        const argumentEvidence = [];
        if (/menu|doc|chapter|page/i.test(name)) parts.forEach((part, position) => {
          const value = part.trim();
          if (/^-?\d{1,9}$/.test(value)) argumentEvidence.push({ position, type: 'integer', value: Number(value) });
          else if (safeLiterals.has(value)) argumentEvidence.push({ position, type: 'menu-id', value: safeLiterals.get(value) });
        });
        summary.calls.push({ name, argumentTypes, argumentEvidence });
      }
      return summary;
    };
    const diagnosticText = (raw, base, limit = limits.text) => cleanSpace(String(raw || '').slice(0, 2048).replace(
      /https?:\/\/[^\s<>"'`]+|(?:\.{0,2}\/)?(?:[A-Za-z0-9_-]+\/)*(?:adocs|cdocs)\.php\?[^\s<>"'`]+/gi,
      rawURL => {
        const accepted = manualURL(rawURL, entry, base);
        if (accepted) return accepted;
        try { const url = new URL(rawURL, base); return `${url.origin}${url.pathname}`; }
        catch { return '[非章节链接]'; }
      })).slice(0, limit);
    const label = (root, base) => {
      let text = '', visited = 0, node = root.firstChild;
      while (node && visited++ < 100 && text.length < limits.text) {
        const skip = node.nodeType === 1 && (blocked(node) || proseRoot(node) || ['ul', 'ol', 'iframe', 'frame'].includes(node.localName));
        if (node.nodeType === 3) text += ' ' + diagnosticText(node.nodeValue, base);
        if (!skip && node.firstChild) { node = node.firstChild; continue; }
        while (node && node !== root && !node.nextSibling) node = node.parentNode;
        node = node && node !== root ? node.nextSibling : null;
      }
      return cleanSpace(text).slice(0, limits.text);
    };
    const topInfo = { ref: 'top', parentRef: null, url: framePath(top.URL), accessible: true };
    snapshot.documents.push(topInfo);
    const queue = [{ doc: top, base: top.URL, info: topInfo, depth: 0 }];
    for (let documentIndex = 0; documentIndex < queue.length; documentIndex++) {
      const context = queue[documentIndex];
      const states = new WeakMap();
      let element = context.doc.documentElement, depth = 0, frameIndex = 0;
      while (element && snapshot.visitedElements < limits.elements) {
        snapshot.visitedElements++;
        const parent = states.get(element.parentElement) || { menu: false, prose: false, parentRef: null };
        const skip = blocked(element);
        let state = parent;
        if (!skip) {
          const info = identity(element);
          const marked = /(?:^|\s)api-menu-item[\w-]*/i.test(`${info.id} ${info.class}`);
          const container = ['nav', 'aside'].includes(info.tag) || ['navigation', 'tree', 'menu', 'menubar', 'tablist'].includes(info.role) ||
            `${info.id} ${info.class}`.split(/\s+/).some(token => !/item/i.test(token) && /(?:^|[_-])(?:menu|sidebar|toc|navigation|tree)(?:$|[_-])/i.test(token));
          const prose = proseRoot(element) || (parent.prose && !container);
          const menu = !prose && (parent.menu || marked || container || menuRoles.has(info.role));
          const explicit = fields.some(name => element.hasAttribute(name));
          const hasLink = ['href', 'data-href', 'data-url', 'onclick'].some(name => element.hasAttribute(name));
          state = { menu, prose, parentRef: proseRoot(element) ? null : parent.parentRef };
          if (!prose && (menu || explicit || hasLink)) {
            snapshot.totalCandidates++;
            if (snapshot.nodes.length < limits.nodes) {
              const ref = `${context.info.ref}:n${snapshot.totalCandidates}`;
              const navigation = attributes(element);
              const record = { ref, documentRef: context.info.ref, order: snapshot.totalCandidates, parentRef: parent.parentRef,
                ...info, text: label(element, context.base), hidden: !visibleControl(element), attributes: navigation.accepted,
                rejectedAttributes: navigation.rejected, links: [], rejectedLinks: [], onclick: handlerSummary(element, context.base), eventListeners: 'unknown' };
              for (const name of ['href', 'data-href', 'data-url']) {
                if (!element.hasAttribute(name)) continue;
                const evidence = linkEvidence(element.getAttribute(name) || '', context.base);
                if (evidence.url) record.links.push({ attribute: name, url: evidence.url });
                else record.rejectedLinks.push({ attribute: name, reason: evidence.reason });
              }
              for (const url of [...record.links.map(link => link.url), ...record.onclick.manualURLs]) {
                if (!found.has(url)) found.set(url, { url, title: record.text || '未命名章节' });
              }
              if (record.onclick.present && !record.onclick.manualURLs.length) diagnostics.unmappedHandlers++;
              snapshot.nodes.push(record);
              state.parentRef = ref;
            }
          }
          if (['iframe', 'frame'].includes(info.tag)) {
            diagnostics.frames++;
            const frameRef = `${context.info.ref}/frame${frameIndex++}`;
            if (snapshot.documents.length >= limits.documents) snapshot.traversalTruncated = true;
            else {
              const frameInfo = { ref: frameRef, parentRef: context.info.ref, accessible: false };
              snapshot.documents.push(frameInfo);
              try {
                if (context.depth >= limits.frameDepth) throw new Error('depth-limit');
                const target = new URL(element.getAttribute('src') || context.base, context.base);
                const blank = target.protocol === 'about:' && target.pathname === 'blank';
                if (!blank && target.origin !== scope.origin) throw new Error('cross-origin');
                frameInfo.url = blank ? 'about:blank' : framePath(target.href);
                const child = element.contentDocument;
                if (!child?.documentElement || !child.body) throw new Error('unavailable');
                const address = child.URL && !child.URL.startsWith('about:') ? new URL(child.URL) : null;
                if (address && address.origin !== scope.origin) throw new Error('cross-origin');
                if (seen.has(child)) throw new Error('already-visited');
                if (loginPage(child, child.URL)) throw new Error('login-required');
                seen.add(child);
                frameInfo.accessible = true;
                if (address) frameInfo.url = framePath(address.href);
                queue.push({ doc: child, base: address?.href || (blank ? context.base : target.href), info: frameInfo, depth: context.depth + 1 });
              } catch (error) {
                frameInfo.reason = ['depth-limit', 'cross-origin', 'unavailable', 'already-visited', 'login-required'].includes(error.message) ? error.message : 'unavailable';
                diagnostics.inaccessibleFrames++;
                if (frameInfo.reason === 'depth-limit') snapshot.traversalTruncated = true;
              }
            }
          }
        }
        states.set(element, state);
        if (!skip && element.firstElementChild && depth < limits.depth) { element = element.firstElementChild; depth++; continue; }
        if (!skip && element.firstElementChild && depth >= limits.depth) snapshot.traversalTruncated = true;
        while (element && !element.nextElementSibling) { element = element.parentElement; depth--; }
        element = element?.nextElementSibling || null;
      }
      if (element) snapshot.traversalTruncated = true;
      if (snapshot.visitedElements >= limits.elements && documentIndex + 1 < queue.length) snapshot.traversalTruncated = true;
    }
    snapshot.exportedCount = snapshot.nodes.length;
    snapshot.candidateCountIsLowerBound = snapshot.traversalTruncated;
    snapshot.truncated = snapshot.traversalTruncated || snapshot.totalCandidates > snapshot.exportedCount;
    diagnostics.linkCount = found.size;
    if (snapshot.truncated) warnings.push('目录结构诊断达到节点或遍历上限，导出仅包含部分观察结果。');
    if (diagnostics.inaccessibleFrames) warnings.push('部分 iframe 无法读取，详情见目录结构诊断。');
    warnings.push('目录结构仅记录当前页面已加载的节点；事件绑定未知，尚未验证全册目录完整性。');
    return { snapshot, links: [...found.values()], title: diagnosticText(top.title, top.URL, 200) };
  }

  function selectRoot(doc, selector) {
    if (selector) return { root: doc.querySelector(selector), selected: 'custom' };
    const selectors = ['main', 'article', '[role="main"]', '#doc-content', '#docContent', '#document-content', '#article-content', '#articleContent', '.markdown-body', '.document-content', '.article-content', '#content', '.content'];
    for (const candidate of selectors) {
      const elements = [...doc.querySelectorAll(candidate)].filter(element => !hidden(element));
      if (elements.length) {
        elements.sort((a, b) => plainText(b).length - plainText(a).length);
        return { root: elements[0], selected: candidate };
      }
    }
    return { root: doc.body, selected: 'body' };
  }

  function buildHTML(root, context, visited = new Set()) {
    const output = context.output;
    const clone = node => {
      if (node.nodeType === 3) return output.createTextNode(node.nodeValue || '');
      if (node.nodeType !== 1) return null;
      const tag = node.localName.toLowerCase();
      if (excluded(node)) {
        if (tag === 'canvas') context.warnings.push('正文包含 canvas 图，未转换为图片，需人工核对。');
        return null;
      }
      if (tag === 'iframe' || tag === 'frame') {
        const child = context.frameDocs.get(node);
        if (!child || visited.has(child)) return null;
        visited.add(child);
        const selected = selectRoot(child, activeProfile ? undefined : context.selector);
        const section = output.createElement('section');
        if (selected.root) section.append(buildHTML(selected.root, context, visited));
        return section;
      }
      const safe = HTML_TAGS.has(tag) ? output.createElement(tag) : output.createDocumentFragment();
      if (tag === 'img') {
        const alt = cleanSpace(node.getAttribute('alt')).slice(0, 300);
        if (alt) safe.setAttribute('alt', alt);
        const raw = node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original') || '';
        context.images.push({ element: safe, raw, base: context.bases.get(node.ownerDocument) || context.entry });
      }
      if (tag === 'a') {
        const raw = node.getAttribute('href') || '';
        const url = manualURL(raw, context.entry, context.bases.get(node.ownerDocument));
        if (url) safe.setAttribute('href', url);
      }
      if (['th', 'td'].includes(tag)) {
        for (const attribute of ['colspan', 'rowspan']) {
          const value = node.getAttribute(attribute);
          if (value && /^\d{1,3}$/.test(value) && Number(value) > 0) safe.setAttribute(attribute, value);
        }
        if (tag === 'th' && ['row', 'col', 'rowgroup', 'colgroup'].includes(node.getAttribute('scope'))) safe.setAttribute('scope', node.getAttribute('scope'));
      }
      if (tag === 'ol') {
        const start = node.getAttribute('start');
        if (start && /^-?\d{1,6}$/.test(start)) safe.setAttribute('start', start);
      }
      if (tag === 'code') {
        const language = (node.getAttribute('class') || '').match(/(?:^|\s)language-([a-zA-Z0-9_-]{1,30})(?:\s|$)/)?.[1];
        if (language) safe.setAttribute('class', `language-${language}`);
      }
      for (const child of node.childNodes) {
        const item = clone(child);
        if (item) safe.append(item);
      }
      return safe;
    };
    return clone(root) || output.createDocumentFragment();
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }

  function sanitizeSVG(bytes) {
    const text = new TextDecoder().decode(bytes);
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('invalid-svg');
    const allowedTags = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath title desc'.split(' '));
    const allowedAttrs = new Set('viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill stroke stroke-width stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity font-size font-family text-anchor dominant-baseline offset stop-color stop-opacity gradientUnits gradientTransform id clip-path'.split(' '));
    const target = document.implementation.createDocument('http://www.w3.org/2000/svg', null);
    const copy = node => {
      if (node.nodeType === 3) return target.createTextNode(node.nodeValue || '');
      if (node.nodeType !== 1 || !allowedTags.has(node.localName)) return null;
      const safe = target.createElementNS('http://www.w3.org/2000/svg', node.localName);
      for (const attribute of node.attributes) {
        const value = attribute.value;
        if (!allowedAttrs.has(attribute.name) || /[<>]|(?:https?:|data:|javascript:|@import)/i.test(value)) continue;
        if (/url\s*\(/i.test(value) && !/^url\(#[a-zA-Z][\w.-]*\)$/.test(value)) continue;
        if (attribute.name === 'id' && !/^[a-zA-Z][\w.-]*$/.test(value)) continue;
        safe.setAttribute(attribute.name, value);
      }
      for (const child of node.childNodes) {
        const safeChild = copy(child);
        if (safeChild) safe.append(safeChild);
      }
      return safe;
    };
    target.append(copy(parsed.documentElement));
    return new TextEncoder().encode(new XMLSerializer().serializeToString(target));
  }

  function isRasterImage(type, bytes) {
    const prefix = (...values) => values.every((value, index) => bytes[index] === value);
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (type === 'image/png') return prefix(137, 80, 78, 71, 13, 10, 26, 10);
    if (type === 'image/jpeg') return prefix(255, 216, 255);
    if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    if (type === 'image/bmp') return ascii(0, 2) === 'BM';
    if (['image/x-icon', 'image/vnd.microsoft.icon'].includes(type)) return prefix(0, 0, 1, 0);
    return false;
  }

  async function readImage(response, signal) {
    if (!response.ok || response.redirected) throw new Error('http-error');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw new Error('not-image');
    const claimed = Number(response.headers.get('content-length'));
    if (claimed > MAX_IMAGE_BYTES) throw new Error('too-large');
    if (!response.body?.getReader) throw new Error('stream-unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error('timeout');
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error('too-large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new Error('empty-image');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { type, bytes };
  }

  async function embedImages(images, entry, warnings, diagnostics) {
    const start = Date.now();
    let total = 0;
    let requests = 0;
    let embedded = 0;
    const cache = new Map();
    const DATA_RE = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon));base64,([a-zA-Z0-9+/=\s]+)$/i;
    // Phase 1 — resolve every image independently and concurrently. Each unique
    // URL is fetched once and shared across duplicates; data: URLs decode without
    // any network or timer. The per-image 4s timeout bounds the slowest transfer,
    // so the page's total image time drops from the sum of fetches to the longest
    // single fetch instead of blocking one image behind another.
    const pending = images.map(async (item, index) => {
      const { element, raw, base } = item;
      if (index >= MAX_IMAGES) return { index, skip: 'over-limit' };
      if (/^data:/i.test(raw)) {
        try {
          const match = raw.match(DATA_RE);
          if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 10) throw new Error('unsupported-data');
          const binary = atob(match[2]);
          return { index, result: { type: match[1].toLowerCase(), bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) } };
        } catch { return { index, error: 'unsupported-data' }; }
      }
      try {
        const url = new URL(raw, base);
        if (!raw || !['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(entry).origin || url.username || url.password) return { index, skip: 'off-origin' };
        if (!/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(url.pathname)) return { index, skip: 'dynamic' };
        url.hash = '';
        if (!cache.has(url.href)) {
          requests += 1;
          const controller = new AbortController();
          const duration = Math.min(MAX_IMAGE_TIME, MAX_TOTAL_IMAGE_TIME - (Date.now() - start));
          const work = fetch(url.href, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal, referrerPolicy: 'no-referrer' }).then(response => readImage(response, controller.signal));
          cache.set(url.href, new Promise((resolve, reject) => {
            const timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, duration);
            work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
          }));
        }
        return { index, result: await cache.get(url.href) };
      } catch (error) {
        return { index, error: error?.message || 'fetch-failed' };
      }
    });
    const outcomes = await Promise.all(pending);
    // Phase 2 — embed sequentially, exactly mirroring the prior per-image checks
    // (size budget, SVG sanitize, raster validation) so the saved output is
    // identical for every image that was reachable.
    for (const outcome of outcomes) {
      const { element } = images[outcome.index];
      const missing = reason => {
        const note = document.createElement('span');
        note.textContent = `[图片未保存${element.getAttribute('alt') ? `：${element.getAttribute('alt')}` : ''}]`;
        element.replaceWith(note);
        warnings.push(`图片 ${outcome.index + 1} 未保存：${reason}。`);
      };
      try {
        if (outcome.skip === 'over-limit') { missing('超过每页 40 张上限'); continue; }
        if (outcome.skip === 'off-origin') { missing('图片不在同源范围内或地址无效'); continue; }
        if (outcome.skip === 'dynamic') { missing('只请求静态图片扩展名，动态地址需人工核对'); continue; }
        if (outcome.error) { missing('下载失败、超时、重定向、过大或格式不受支持'); continue; }
        const result = outcome.result;
        if (result.bytes.byteLength > MAX_IMAGE_BYTES || total + result.bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) { missing('超过图片大小上限'); continue; }
        let bytes = result.bytes;
        if (result.type === 'image/svg+xml') bytes = sanitizeSVG(bytes);
        else if (!isRasterImage(result.type, bytes)) throw new Error('invalid-image');
        if (bytes.byteLength > MAX_IMAGE_BYTES || total + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) throw new Error('too-large');
        element.setAttribute('src', `data:${result.type};base64,${bytesToBase64(bytes)}`);
        total += bytes.byteLength;
        embedded += 1;
      } catch {
        missing('下载失败、超时、重定向、过大或格式不受支持');
      }
    }
    diagnostics.images = { found: images.length, embedded, missing: images.length - embedded, requests, bytes: total };
  }

  function markdown(root) {
    const inline = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]])/g, '\\$1');
    const convert = (node, depth = 0) => {
      if (node.nodeType === 3) return inline((node.nodeValue || '').replace(/\s+/g, ' '));
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      const tag = node.localName;
      const children = () => [...node.childNodes].map(child => convert(child, depth)).join('');
      if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
      if (tag === 'br') return '  \n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'pre') {
        const code = node.querySelector('code');
        const text = node.textContent || '';
        const maxTicks = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
        const fence = '`'.repeat(maxTicks + 1);
        const language = code?.getAttribute('class')?.replace('language-', '') || '';
        return `\n\n${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}\n\n`;
      }
      if (tag === 'code') {
        const text = node.textContent || '';
        const ticks = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
        return `${ticks}${text.includes('`') ? ' ' : ''}${text}${text.includes('`') ? ' ' : ''}${ticks}`;
      }
      if (tag === 'strong' || tag === 'b') return `**${children()}**`;
      if (tag === 'em' || tag === 'i') return `*${children()}*`;
      if (tag === 'del' || tag === 's') return `~~${children()}~~`;
      if (tag === 'a') {
        const text = children();
        return node.hasAttribute('href') ? `[${text}](${node.getAttribute('href').replace(/\)/g, '%29')})` : text;
      }
      if (tag === 'img') return node.hasAttribute('src') ? `![${inline(node.getAttribute('alt') || '')}](${node.getAttribute('src')})` : '';
      if (tag === 'ul' || tag === 'ol') {
        const start = Number(node.getAttribute('start')) || 1;
        const items = [...node.children].filter(child => child.localName === 'li').map((li, i) => {
          const prefix = tag === 'ol' ? `${start + i}. ` : '- ';
          const content = [...li.childNodes].map(child => {
            if (['ul', 'ol'].includes(child.localName)) return `\n${convert(child, 0).trim()}\n`;
            return convert(child, 0);
          }).join('').trim();
          const [first, ...remaining] = content.split('\n');
          return `${prefix}${first}${remaining.length ? '\n' : ''}${remaining.map(line => line.trim() ? ' '.repeat(prefix.length) + line : '').join('\n')}`;
        });
        return `\n\n${items.join('\n')}\n\n`;
      }
      if (tag === 'blockquote') return `\n\n${children().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      if (tag === 'table') {
        if (node.querySelector('[colspan]:not([colspan="1"]), [rowspan]:not([rowspan="1"]), table')) return `\n\n${node.outerHTML}\n\n`;
        const rows = [...node.querySelectorAll('tr')].map(row => [...row.children].filter(cell => ['th', 'td'].includes(cell.localName)).map(cell => [...cell.childNodes].map(child => convert(child, depth)).join('').trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(row => row.length));
        const formatted = rows.map(row => `| ${Array.from({ length: width }, (_, index) => row[index] || '').join(' | ')} |`);
        formatted.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
        return `\n\n${formatted.join('\n')}\n\n`;
      }
      const text = children();
      return BLOCK_TAGS.has(tag) ? `\n\n${text}\n\n` : text;
    };
    return convert(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // A compact body fingerprint lets the controller wait for asynchronous content
  // after a directory click. The tree and form controls use the same exclusions.
  function readState(options = {}) {
    activeProfile = options.profile || null;
    try {
      const document = activeProfile?.frameSelector ? globalThis.document.querySelector(activeProfile.frameSelector)?.contentDocument : globalThis.document;
      if (!document?.body) throw new Error('frame-unavailable');
      const entry = options.entry || location.href;
      const { documents } = collectDocuments(document, entry, [], { frames: 0, inaccessibleFrames: 0 }, options.selector);
      const roots = documents.map(({ doc, base }) => ({ root: selectRoot(doc, activeProfile && doc !== document ? undefined : options.selector).root, base }));
      const text = roots.map(({ root }) => plainText(root)).join('\n').trim();
      const imageState = [];
      if (activeProfile) for (const { root, base } of roots) {
        const images = root ? [...(root.matches?.('img') ? [root] : []), ...root.querySelectorAll('img')] : [];
        for (const image of images) {
          if (!visibleControl(image)) continue;
          let blocked = false;
          for (let parent = image; parent && root.contains(parent); parent = parent.parentElement) if (excluded(parent)) { blocked = true; break; }
          if (blocked) continue;
          const raw = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original') || '';
          if (!raw.trim()) continue;
          let source = raw;
          try { source = new URL(raw, base).href; } catch { /* Capture will report unsupported image sources. */ }
          imageState.push([source, image.getAttribute('alt') || '']);
        }
      }
      const masks = '.ext-el-mask, .ext-el-mask-msg, .x-mask, .x-mask-msg, .x-loading-mask';
      const loading = activeProfile ? roots.some(({ root }) => {
        if (!root || !visibleControl(root)) return false;
        for (let parent = root; parent; parent = parent.parentElement) if (parent.getAttribute('aria-busy') === 'true') return true;
        return [...root.querySelectorAll(masks + ',[aria-busy="true"]')].some(node => {
          if (!visibleControl(node) || (activeProfile.tocSelector && node.closest(activeProfile.tocSelector))) return false;
          for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) if (excluded(parent)) return false;
          return true;
        });
      }) : documents.some(({ doc }) => [...doc.querySelectorAll(masks)].some(visibleControl));
      let hash = 2166136261;
      const feed = value => { for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); };
      feed(text);
      for (const fields of imageState) for (const value of fields) { feed('\u0000' + value.length + ':'); feed(value); }
      return { signature: `${text.length}:${hash >>> 0}`, nonEmpty: Boolean(text || imageState.length), loading,
        url: displayURL(location.href, options.entry || location.href),
        auth: documents.some(({ doc, base }) => loginPage(doc, base)) };
    } catch (error) { return { signature: '', nonEmpty: false, error: 'invalid-content-root', fault: errShape(error) }; }
  }

  async function capture(options = {}) {
    const captureStarted = Date.now();
    activeProfile = options.profile || null;
    visibilityFaults = [];
    const document = activeProfile?.frameSelector ? globalThis.document.querySelector(activeProfile.frameSelector)?.contentDocument : globalThis.document;
    const entry = options.entry || location.href;
    const warnings = [];
    const diagnostics = { frames: 0, inaccessibleFrames: 0, unmappedHandlers: 0, linkCount: 0 };
    const result = { status: 'error', url: displayURL(location.href, entry), title: '', text: '', markdown: '', html: '', links: [], warnings, diagnostics };
    try {
      if (!document?.body) { diagnostics.reason = 'frame-unavailable'; return result; }
      if (!manualURL(entry, entry)) { diagnostics.reason = 'invalid-entry'; return result; }
      Object.assign(diagnostics, await waitForDOM(document, options));
      if (!diagnostics.settled) warnings.push('在等待上限内未确认正文稳定，采集结果需核对。');
      // Read the address after the wait: the manual may set a default chapter
      // with a redirect or history.replaceState while its content loads.
      const actualAddress = location.href;
      const requestedAddress = options.expectedURL || actualAddress;
      const current = manualURL(actualAddress, entry);
      const expected = manualURL(requestedAddress, entry);
      result.url = displayURL(actualAddress, entry);
      diagnostics.navigation = {
        expectedURL: displayURL(requestedAddress, entry),
        actualURL: result.url,
        actualQueryKeys: [...new Set(new URL(actualAddress).searchParams.keys())].map(key => key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)).slice(0, 20),
        acceptedDirectoryRedirect: false,
      };
      if (loginPage(document, actualAddress)) { result.status = 'auth'; diagnostics.reason = 'login-required'; return result; }
      const directoryRedirect = Boolean(options.scanOnly === true && expected && current &&
        !new URL(expected).search && current !== expected);
      if (!current || !expected || (current !== expected && !directoryRedirect && !(activeProfile && options.locator))) {
        diagnostics.reason = 'url-mismatch';
        result.error = options.scanOnly ? '目录扫描时实际地址不在预期的手册范围内。' : '实际页面地址与请求章节不一致，未保存该页。';
        return result;
      }
      if (directoryRedirect) {
        diagnostics.navigation.acceptedDirectoryRedirect = true;
        warnings.push('目录入口已转到本手册的合法章节，已从该页面读取目录；尚未验证全册目录完整性。');
      }
      result.url = current;
      if (options.scanOnly === true && options.includeStructure === true) {
        const structure = menuStructure(document, entry, warnings, diagnostics);
        diagnostics.menuSnapshot = structure.snapshot;
        result.links = structure.links;
        result.status = 'ok';
        result.title = structure.title;
        return result;
      }
      const { documents, frameDocs } = collectDocuments(document, entry, warnings, diagnostics, options.selector);
      if (documents.some(({ doc, base }) => loginPage(doc, base))) { result.status = 'auth'; diagnostics.reason = 'login-required'; return result; }
      result.links = activeProfile ? [] : discover(documents, entry, diagnostics);
      if (diagnostics.unmappedHandlers) warnings.push(`发现 ${diagnostics.unmappedHandlers} 个无法映射为实际手册地址的目录事件；未执行这些事件，目录可能不完整。`);
      if (options.scanOnly) {
        if (globalThis.SangforTree) {
          const tree = globalThis.SangforTree.scan({ entry });
          result.links.push(...tree.items);
          diagnostics.tree = tree.diagnostics;
          warnings.push(...tree.warnings);
        }
        result.title = cleanSpace(plainText(document.querySelector('h1')) || document.title).slice(0, 300);
        result.status = 'ok';
        return result;
      }
      let selected;
      try { selected = selectRoot(document, options.selector); }
      catch { diagnostics.reason = 'invalid-selector'; return result; }
      if (!selected.root) { diagnostics.reason = 'selector-not-found'; return result; }
      diagnostics.selected = selected.selected;
      if (selected.selected === 'body') warnings.push('未识别到专用正文区域，已使用 body 回退提取；请检查是否混入导航或遗漏章节。');
      const output = document.implementation.createHTMLDocument('');
      const container = output.createElement('section');
      const context = { output, entry, warnings, images: [], frameDocs, selector: options.selector, bases: new Map(documents.map(item => [item.doc, item.base])) };
      container.append(buildHTML(selected.root, context, new Set([document])));
      // Some manuals put the article frame outside a small top-level <main>.
      // Include accessible frame documents that were not nested in the selected root.
      for (const frame of activeProfile ? [] : document.querySelectorAll('iframe,frame')) {
        if (!selected.root.contains(frame) && frameDocs.has(frame)) container.append(buildHTML(frame, context, new Set([document])));
      }
      const imageStarted = Date.now();
      await embedImages(context.images, entry, warnings, diagnostics);
      diagnostics.timing = { imagesMs: Date.now() - imageStarted };
      result.title = cleanSpace(plainText(container.querySelector('h1,h2,h3')) || document.title).slice(0, 300) || '未命名章节';
      result.text = plainText(container).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      result.markdown = markdown(container);
      result.html = container.innerHTML;
      diagnostics.characters = result.text.length;
      if (!result.text && !diagnostics.images.embedded) { diagnostics.reason = 'empty-content'; return result; }
      if (options.locator) {
        const proof = activeProfile ? globalThis.SecurityManualAdapters.verify({profile:activeProfile,chapter:options.chapter}) : globalThis.SangforTree?.verify({ entry, locator: options.locator });
        if (!proof?.verified) { diagnostics.reason = 'tree-selection-mismatch'; return result; }
        result.navigationProof = proof;
        result.title = options.chapterTitle || options.locator.path.at(-1);
      }
      result.status = 'ok';
      return result;
    } catch (error) {
      diagnostics.reason = 'capture-failed';
      diagnostics.fault = errShape(error);
      if (visibilityFaults.length) diagnostics.visibilityFaults = visibilityFaults.slice(0, 10);
      warnings.push('页面提取发生错误；未记录页面脚本或敏感字段，请人工检查页面结构。');
      return result;
    } finally {
      diagnostics.timing = { ...diagnostics.timing, domWaitMs: diagnostics.waitedMs || 0, extractionTotalMs: Date.now() - captureStarted };
    }
  }

  globalThis.ManualCapture = Object.freeze({ capture, readState });
})();
