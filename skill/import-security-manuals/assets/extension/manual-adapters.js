/* Declarative DOM adapters. Never evaluate page handlers or issue API requests. */
(() => {
  'use strict';
  if (globalThis.SecurityManualAdapters) return;
  const sensitive = /(?:password|passwd|secret|token|authorization|cookie|session|credential|ticket|csrf|api[_-]?key|^sid$|^jwt$)/i;
  // Keep equivalent to profiles.normalizeDocumentURL; an equivalence test guards this copy.
  function normalizeURL(raw, profile, base = profile?.entry) {
    if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
    try {
      const url = new URL(raw.trim().replace(/&amp;/gi, '&'), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== profile.origin) return null;
      const prefix = profile.pathPrefix || '/';
      if (!(prefix === '/' || url.pathname === prefix || url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) return null;
      if (/\/(?:logout|logoff|delete|remove|save|commit|apply|execute|reboot|shutdown)(?:[./_-]|$)/i.test(url.pathname)) return null;
      if ([...url.searchParams.keys()].some(key => sensitive.test(key) || !(profile.queryKeys || []).includes(key))) return null;
      if (profile.hashMode !== 'route') url.hash = '';
      else {
        // Decode route query keys exactly as ordinary URL queries before storing them.
        const queryStart = url.hash.search(/[?&]/);
        if (queryStart !== -1 && [...new URLSearchParams(url.hash.slice(queryStart + 1)).keys()].some(key => sensitive.test(key))) return null;
      }
      return url.href;
    } catch { return null; }
  }
  const EXCLUDED = 'form,input,textarea,select,option,pre,code,script,style,template,[contenteditable]:not([contenteditable="false"]),[data-security-picker]';
  const NAV = 'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],[role="tree"],.yama-layout-header__content__menu,.x-tab-strip';
  const TOC = NAV + ',aside,.toc,#toc,.table-of-contents,.sidebar,.x-tree-root-ct';
  const ACTION = 'a[href],button,[role="treeitem"],[role="tab"],[role="menuitem"],[data-href],[data-url]';
  const MAX_ROWS = 50000, MAX_ITEMS = 5000;
  const space = value => String(value || '').replace(/\s+/g, ' ').trim();
  const pathKey = path => JSON.stringify(path);
  // A truncated scan must never be shortcut, so the last result is remembered.
  const scanState = new WeakMap();
  const chapterKey = locator => 'toc:' + encodeURIComponent(JSON.stringify([locator.kind, locator.path, locator.nodeId || '']));
  let activeProfile, cancelPicker;
  function readable(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(EXCLUDED)) return '';
    return [...node.childNodes].filter(child => child.nodeType !== 1 || !child.matches('ul,ol,[role="group"]')).map(readable).join(' ');
  }
  function titleOf(el) { return space(readable(el)); }
  function unique(doc, selector) {
    if (typeof selector !== 'string' || !selector || selector.length > 1000) throw new Error('请先点选目录或正文区域');
    const nodes = doc.querySelectorAll(selector);
    if (nodes.length !== 1) throw new Error('页面定位规则失效或不唯一，请重新校准');
    return nodes[0];
  }
  function selectorFor(el) {
    const doc = el.ownerDocument;
    const quote = value => String(value).replace(/[^a-zA-Z0-9_-]/g, char => '\\' + char.codePointAt(0).toString(16) + ' ');
    if (el.id) { const selector = '#' + quote(el.id); if (doc.querySelectorAll(selector).length === 1) return selector; }
    const parts = [];
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      let part = node.localName;
      const siblings = node.parentElement && [...node.parentElement.children].filter(x => x.localName === part);
      if (siblings?.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (doc.querySelectorAll(selector).length === 1) return selector;
    }
    throw new Error('无法定位所选区域');
  }
  // Only what identifies a fault crosses the chrome.scripting.executeScript()
  // boundary: only what identifies a fault leaves the page. Secrets in
  // messages/stacks are stripped by redact() so credentials never reach the log.
  const SENSITIVE_KEY = /(?:token|api[_-]?key|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|authorization|auth|session[_-]?id|set[_-]?cookie|cookie)/i;
  const redact = text => {
    if (text == null) return text;
    let s = String(text);
    s = s.replace(/(https?:\/\/[^\s"'<>?#]+)(\?[^?\s"'<>]*)?(#[^\s"'<>]*)?/g, (m, base) => base);
    s = s.replace(/(Authorization\s*:\s*(?:Bearer\s+)?)\S+/gi, '$1<redacted>');
    s = s.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
    s = s.replace(/(?:Set-)?Cookie\s*:\s*\S+/gi, m => m.replace(/\S+$/, '<redacted>'));
    s = s.replace(new RegExp('(' + SENSITIVE_KEY.source + '\\s*[=:]\\s*)\\S+', 'gi'), '$1<redacted>');
    return s;
  };
  const errShape = e => e?.fault || ({ name: String(e?.name || 'Error'), message: redact(String(e?.message || e || '').slice(0, 500)),
    stack: redact(String(e?.stack || '').split('\n').slice(0, 8).join('\n')).slice(0, 1200) });

  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      // Undecidable visibility must never be reported as visible, or the caller
      // would click and collect from an entry that was never proven usable.
      const view = node.ownerDocument?.defaultView;
      if (!view) throw Object.assign(new Error('无法读取目录项的显示状态：文档窗口不可用'), { fault: errShape(new Error('defaultView unavailable')) });
      let style;
      try { style = view.getComputedStyle(node); }
      catch (error) { throw Object.assign(new Error(error?.message || '无法读取目录项的显示状态'), { fault: errShape(error) }); }
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return true;
  }
  function blocked(el) { return Boolean(el.closest(EXCLUDED + ',[disabled],[aria-disabled="true"],.x-item-disabled,.is-disabled')); }
  function context(profile, requireTOC = true) {
    if (!profile || !normalizeURL(location.href, profile) || !normalizeURL(profile.entry, profile)) throw new Error('当前页面不在已确认的手册范围');
    let doc = document;
    if (profile.frameSelector) {
      const frame = unique(document, profile.frameSelector);
      if (!frame.matches('iframe,frame')) throw new Error('所选元素不是文档框架');
      try {
        const frameURL = new URL(frame.src || 'about:blank', location.href);
        if (frameURL.href !== 'about:blank' && frameURL.origin !== profile.origin) throw new Error();
        doc = frame.contentDocument;
        if (!doc?.documentElement) throw new Error();
      } catch { throw new Error('无法访问所选文档框架，请在该手册页面直接打开扩展'); }
    }
    if (!requireTOC) return { doc };
    const root = unique(doc, profile.tocSelector);
    if (root.matches('html,body,main,article,[role="main"]') || root.closest(EXCLUDED)) throw new Error('目录必须限定为独立导航区域，不能选择整页或正文');
    let content;
    try { content = profile.contentSelector ? unique(doc, profile.contentSelector) : null; } catch { /* Capture validates this separately. */ }
    if (root === content) throw new Error('目录与正文不能选择同一区域');
    return { doc, root, content };
  }
  function candidates(root) {
    const list = [...root.querySelectorAll(ACTION)];
    for (const li of root.querySelectorAll('li')) if (!li.querySelector(ACTION) && !li.querySelector('ul,ol,[role="group"]')) list.push([...li.children].find(child => child.matches('span') && titleOf(child)) || li);
    return list.filter(el => !blocked(el) && !el.querySelector(ACTION));
  }
  function observedPath(target, root) {
    const path = [titleOf(target)];
    const row = target.closest('li,[role="treeitem"]');
    for (let node = row?.parentElement || target.parentElement; node && node !== root; node = node.parentElement) {
      if (node.matches('li,[role="treeitem"]')) { const title = titleOf(node); if (title) path.unshift(title); }
    }
    return path;
  }
  function expandable(el, root) {
    if (blocked(el)) return false;
    if (el.matches('summary') && el.parentElement?.matches('details:not([open])')) return true;
    if (el.getAttribute('aria-expanded') !== 'false') return false;
    if (el.matches('[role="treeitem"]') && root.matches('[role="tree"],nav,aside,ul,ol')) return true;
    const controls = el.getAttribute('aria-controls');
    if (controls) {
      const controlled = el.ownerDocument.getElementById(controls);
      if (controlled && root.contains(controlled) && el.ownerDocument.querySelectorAll('[id]').length &&
          [...el.ownerDocument.querySelectorAll('[id]')].filter(x => x.id === controls).length === 1) return true;
    }
    return Boolean(el.closest('li')?.querySelector('ul,ol,[role="group"]'));
  }
  function branchLoaded(control, root) {
    const controls = control.getAttribute('aria-controls');
    let children;
    if (controls) {
      const matches = [...control.ownerDocument.querySelectorAll('[id]')].filter(el => el.id === controls);
      if (matches.length !== 1 || !root.contains(matches[0])) return false;
      children = matches[0];
    } else {
      const row = control.matches('summary') ? control.parentElement : control.closest('li,[role="treeitem"]');
      children = row?.querySelector('ul,ol,[role="group"],.x-tree-node-ct');
      if (!children && control.matches('summary')) children = row;
    }
    // A child branch is useful loaded structure too: it will be expanded next.
    // The parent label, an empty container, and aria-expanded alone are not.
    return Boolean(children && candidates(children).some(el => titleOf(el)));
  }
  function inventory(profile) {
    const { doc, root, content } = context(profile);
    const diagnostics = { rows: 0, ambiguousPaths: 0, pendingBranches: 0, truncated: false, inaccessibleFrames: 0 };
    const warnings = [], records = [], pathCounts = new Map(), byURL = new Map();
    const raw = candidates(root);
    for (const target of raw.slice(0, MAX_ROWS)) {
      diagnostics.rows++;
      if (content?.contains(target) && !content.contains(root)) continue;
      if (target.hasAttribute('aria-expanded') || target.querySelector('ul,ol,[role="group"]')) continue;
      const title = titleOf(target);
      const path = observedPath(target, root);
      if (!title || title.length > 200 || path.length > 12 || path.some(x => !x || x.length > 200)) { warnings.push('有目录标题为空或路径超出上限，已跳过'); continue; }
      const href = target.getAttribute('href') || target.getAttribute('data-href') || target.getAttribute('data-url');
      const url = href ? normalizeURL(href, profile, doc.URL === 'about:blank' ? profile.entry : doc.URL) : null;
      if (href && !url && !/^\s*(?:#|javascript:\s*(?:void\(0\)|;?))\s*;?\s*$/i.test(href)) { warnings.push('有目录链接不在允许范围，已跳过'); continue; }
      const click = profile.navigation === 'click' || !url || href.trim() === '#';
      const locator = { kind: 'generic-toc', path };
      const id = target.id;
      if (id && /^[\w:.-]{1,200}$/.test(id)) locator.nodeId = id;
      const chapter = click ? {key: chapterKey(locator), url: url || normalizeURL(location.href, profile), title, locator}
        : {key: 'url:' + url, url, title};
      const record = { target, row: target.closest('li,[role="treeitem"]') || target, chapter, path };
      if (click) pathCounts.set(pathKey(path), (pathCounts.get(pathKey(path)) || 0) + 1);
      else if (byURL.has(url)) continue;
      else byURL.set(url, record);
      records.push(record);
    }
    const duplicatePaths = new Set([...pathCounts].filter(([, count]) => count > 1).map(([key]) => key));
    diagnostics.ambiguousPaths = duplicatePaths.size;
    const unloaded = [...root.querySelectorAll('[aria-expanded="true"],details[open] > summary')].filter(el => !blocked(el) && !branchLoaded(el, root));
    diagnostics.unloadedBranches = unloaded.length;
    diagnostics.pendingBranches = [...root.querySelectorAll('[aria-expanded="false"],details:not([open]) > summary')].filter(el => expandable(el, root)).length + unloaded.length;
    diagnostics.truncated = raw.length > MAX_ROWS || records.length > MAX_ITEMS;
    scanState.set(doc, { truncated: diagnostics.truncated });
    if (duplicatePaths.size) warnings.push('有重复目录路径，已排除歧义章节，请重新校准');
    if (diagnostics.pendingBranches) warnings.push('仍有未展开或未加载的目录分支，目录可能不完整');
    if (diagnostics.truncated) warnings.push('目录达到扫描上限，结果不完整');
    if (root.querySelector('[aria-setsize],[aria-posinset]')) warnings.push('目录存在分段或虚拟列表标记；只发现已加载项，请核对完整目录');
    if (doc.querySelector('iframe,frame')) warnings.push('嵌套框架中的目录未自动合并，请分别校准');
    return { root, doc, warnings: [...new Set(warnings)], diagnostics,
      records: records.filter(record => !record.chapter.locator || !duplicatePaths.has(pathKey(record.path))).slice(0, MAX_ITEMS) };
  }
  async function expand(profile) {
    const started = Date.now(), attempted = new WeakSet(); let expanded = 0;
    while (expanded < 100 && Date.now() - started < 12000) {
      const { root, content } = context(profile);
      const controls = [...root.querySelectorAll('[aria-expanded="false"],details:not([open]) > summary')];
      if (profile.adapterId === 'sangfor') controls.push(...root.querySelectorAll('.x-tree-node-el > .tree-has-child'));
      const control = controls.find(el => {
        if (blocked(el) || (content?.contains(el) && !content.contains(root))) return false;
        const isExt = profile.adapterId === 'sangfor' && el.matches('.x-tree-node-el > .tree-has-child');
        if (!isExt && !expandable(el, root)) return false;
        if (isExt) { const children = el.parentElement.parentElement.querySelector(':scope > ul'); if (children?.children.length && visible(children)) return false; }
        return !attempted.has(el);
      });
      if (!control) break;
      attempted.add(control); control.click(); expanded++;
      // Some trees set aria-expanded immediately, then render children seconds
      // later. Wait for actual child entries, within both branch and total limits.
      await new Promise(resolve => {
        let quiet, limit;
        const settle = () => { if (branchLoaded(control, root)) done(); };
        const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(settle, 120); });
        const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(limit); resolve(); };
        observer.observe(root, {childList:true,subtree:true,attributes:true});
        quiet = setTimeout(settle, 200); limit = setTimeout(done, Math.max(0, Math.min(6000, 12000 - (Date.now() - started))));
      });
    }
    return { expanded, expansionLimited: expanded >= 100 || Date.now() - started >= 12000 };
  }
  function detect({ entry = location.href } = {}) {
    const warnings = [];
    const address = new URL(entry, location.href);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.origin !== location.origin) throw new Error('请选择当前来源的手册页');
    const findRegions = doc => {
      const choices = [...doc.querySelectorAll(TOC)].filter(el => !el.closest(EXCLUDED));
      choices.sort((a,b) => b.querySelectorAll(ACTION).length - a.querySelectorAll(ACTION).length);
      const root = choices[0];
      const body = [...doc.querySelectorAll('main,article,[role="main"],.markdown-body,#doc-content,#docContent,#document-content,#article-content,#articleContent,.document-content,.article-content,#content,.content')].find(el => el !== root && !root?.contains(el) && !el.closest(EXCLUDED));
      return { root, body };
    };
    let doc = document, regions = findRegions(doc), frameSelector;
    if (!regions.root || !regions.body) {
      const usable = [];
      for (const frame of document.querySelectorAll('iframe,frame')) {
        try { const frameURL = new URL(frame.src || 'about:blank', location.href); const child = frame.contentDocument;
          if (frameURL.href !== 'about:blank' && frameURL.origin !== address.origin) throw new Error();
          if (child?.documentElement) { const found = findRegions(child); if (found.root && found.body) usable.push({doc:child,regions:found,frameSelector:selectorFor(frame)}); }
        } catch { warnings.push('有无法访问的跨域文档框架，需要单独打开该手册'); }
      }
      if (usable.length === 1) ({doc, regions, frameSelector} = usable[0]);
      else if (usable.length > 1) warnings.push('发现多个文档框架，请点选需要的目录和正文');
    }
    const sangfor = /^\/(?:adocs|cdocs)\.php$/.test(address.pathname) && Boolean(doc.querySelector('.x-tree-root-ct'));
    if (sangfor) regions.root = doc.querySelector('.x-tree-root-ct');
    const profile = {schemaVersion:1,id:'',revision:1,name:space(doc.title || document.title || '我的手册').slice(0,120),adapterId:sangfor?'sangfor':'generic',
      entry:address.href,origin:address.origin,pathPrefix:sangfor?address.pathname:address.pathname.slice(0,address.pathname.lastIndexOf('/')+1)||'/',
      hashMode:/^#!?\//.test(address.hash)?'route':address.hash?'anchor':'none',queryKeys:[...new Set(address.searchParams.keys())].filter(key=>!sensitive.test(key)),
      tocSelector:regions.root?selectorFor(regions.root):'',contentSelector:regions.body?selectorFor(regions.body):'',navigation:'links',samples:[]};
    if (frameSelector) profile.frameSelector = frameSelector;
    if (regions.root) {
      const targets = candidates(regions.root);
      if (targets.some(el => /^#!?\//.test(el.getAttribute('href')||''))) profile.hashMode = 'route';
      for (const el of targets) {
        try {const u=new URL(el.getAttribute('href'),address.href);if(u.origin===address.origin&&u.pathname.startsWith(profile.pathPrefix))for(const key of u.searchParams.keys())if(!sensitive.test(key)&&!profile.queryKeys.includes(key))profile.queryKeys.push(key);} catch {}
      }
      if (sangfor || targets.some(el=>!el.getAttribute('href') || !normalizeURL(el.getAttribute('href'),profile))) profile.navigation = 'click';
    }
    if (sangfor) profile.queryKeys = ['index','dataID'];
    if (!regions.root) warnings.push('未自动识别目录，请点选目录区域');
    if (!regions.body) warnings.push('未自动识别正文，请点选正文区域');
    if (!normalizeURL(profile.entry,profile)) throw new Error('入口含未允许的认证参数，请先打开不含认证参数的手册地址');
    activeProfile = profile;
    return {profile,warnings};
  }
  async function discover({ profile } = {}) {
    activeProfile = profile;
    try {
      const progress = await expand(profile);
      if (profile.adapterId === 'sangfor') {
        context(profile);
        if (profile.frameSelector || !globalThis.SangforTree) throw new Error('内置树目录读取器未加载，或该框架目录尚未适配');
        const result = globalThis.SangforTree.scan({entry:profile.entry});
        return {...result,items:result.items.map(item=>({...item,key:chapterKey(item.locator)})),diagnostics:{...result.diagnostics,...progress},warnings:[...result.warnings,...(progress.expansionLimited?['目录展开达到上限，请核对未加载分支']:[])]};
      }
      const state = inventory(profile);
      return {items:state.records.map(record=>record.chapter),warnings:[...state.warnings,...(progress.expansionLimited?['目录展开达到上限，请核对未加载分支']:[])],diagnostics:{...state.diagnostics,...progress}};
    } catch (error) { return {items:[],warnings:[error.message],fault:errShape(error),diagnostics:{reason:'invalid-directory'}}; }
  }
  function locate(profile, chapter) {
    if (!normalizeURL(chapter?.url,profile)) throw new Error('章节地址不在允许范围');
    const locator = chapter.locator;
    if (locator?.kind !== 'generic-toc' || !Array.isArray(locator.path) || !locator.path.length || locator.path.length > 12 || locator.path.some(x=>typeof x!=='string'||!x.trim()||x.length>200)) throw new Error('无效的目录路径');
    const state = inventory(profile);
    if (state.diagnostics.truncated) throw new Error('目录扫描不完整，不能唯一确认章节');
    const found = state.records.filter(record=>pathKey(record.path)===pathKey(locator.path));
    if (found.length !== 1) throw new Error('目录路径不存在或不唯一');
    const record = found[0];
    if (locator.nodeId && record.target.id !== locator.nodeId) throw new Error('目录节点身份已变化');
    return record;
  }
  function open({ profile, chapter } = {}) {
    try {
      context(profile);
      if (!normalizeURL(chapter?.url,profile)) throw new Error('章节地址不在允许范围');
      if (profile.adapterId==='sangfor' && chapter.locator?.kind==='sangfor-ext-tree') return globalThis.SangforTree?.open({entry:profile.entry,locator:chapter.locator}) || {clicked:false,reason:'reader-unavailable'};
      if (!chapter.locator) return {clicked:false,reason:'link-navigation-required'};
      const {target} = locate(profile,chapter);
      if (!visible(target) || blocked(target)) throw new Error('目录项不可见或不可用，请展开目录后重试');
      target.click();return {clicked:true};
    } catch(error) {return {clicked:false,reason:error.message,fault:errShape(error)};}
  }
  const markerSelected = el => el.getAttribute('aria-selected')==='true' || Boolean(el.getAttribute('aria-current') && el.getAttribute('aria-current')!=='false') || el.matches('.selected,.active,.current,.x-tree-selected,.ix-menu-item-selected');

  // The controller polls this while a chapter loads, so it must not rescan the
  // whole directory each time. An observed element id is unique in the document;
  // requiring the recorded path to match keeps the proof as strict as locate().
  // Anything not provable this way returns null to fall back to a full scan.
  function quickVerify(profile, chapter) {
    const locator = chapter?.locator;
    if (!locator?.nodeId || profile?.frameSelector) return null;
    const doc = document;
    if (scanState.get(doc)?.truncated) return null;
    let root;
    try { root = unique(doc, profile.tocSelector); } catch { return null; }
    const target = doc.getElementById(locator.nodeId);
    if (!target || !root.contains(target)) return null;
    if (pathKey(observedPath(target, root)) !== pathKey(locator.path)) return null;
    const row = target.closest('li,[role="treeitem"]') || target;
    return markerSelected(target) || markerSelected(row);
  }

  function verify({ profile, chapter } = {}) {
    const result = {verified:false,kind:chapter?.locator?.kind||'url',...(chapter?.locator?.path?{path:chapter.locator.path}:{})};
    try {
      context(profile,false);
      if (profile.adapterId==='sangfor' && chapter.locator?.kind==='sangfor-ext-tree') return globalThis.SangforTree?.verify({entry:profile.entry,locator:chapter.locator}) || {...result,reason:'reader-unavailable'};
      if (!chapter.locator) return {...result,verified:Boolean(normalizeURL(chapter.url,profile)&&normalizeURL(location.href,profile)===normalizeURL(chapter.url,profile)),reason:'url-comparison'};
      const quick = quickVerify(profile, chapter);
      if (quick !== null) return {...result, verified: quick, reason: quick ? 'selected-directory-marker' : 'selected-directory-mismatch'};
      const {target,row} = locate(profile,chapter);
      return {...result,verified:markerSelected(target)||markerSelected(row),reason:'selected-directory-marker'};
    } catch(error) {return {...result,reason:error.message,fault:errShape(error)};}
  }
  function pick({kind,profile=activeProfile} = {}) {
    if (!['toc','content','sample','rotation'].includes(kind)) return Promise.reject(new Error('未知点选类型'));
    if (cancelPicker) cancelPicker();
    return new Promise((resolve,reject)=>{
      const documents = [{doc:document}];
      for (const frame of document.querySelectorAll('iframe,frame')) {
        try {const url=new URL(frame.src||'about:blank',location.href);if(url.href!=='about:blank'&&url.origin!==location.origin)continue;if(frame.contentDocument?.documentElement)documents.push({doc:frame.contentDocument,frameSelector:selectorFor(frame)});} catch {}
      }
      const banner=document.createElement('div');banner.dataset.securityPicker='';banner.textContent='点选'+({toc:'目录区域',content:'正文区域',sample:'目录中的样例章节',rotation:'导航菜单'}[kind])+'；按 Esc 取消';
      Object.assign(banner.style,{position:'fixed',top:'12px',left:'12px',zIndex:'2147483647',padding:'12px',background:'#123b35',color:'white',borderRadius:'8px',pointerEvents:'none'});document.documentElement.append(banner);
      const outline=document.createElement('div');outline.dataset.securityPicker='';Object.assign(outline.style,{position:'fixed',pointerEvents:'none',zIndex:'2147483646',border:'3px solid #16a085'});document.documentElement.append(outline);
      const bindings=[['click',click],['keydown',key],['mousemove',hover],...['pointerdown','pointerup','pointercancel','mousedown','mouseup','touchstart','touchend','touchcancel','keyup','auxclick','dblclick','contextmenu'].map(name=>[name,suppress])];
      let finished=false;
      function finish(error,value) {
        if(finished)return;finished=true;
        for(const {doc} of documents)for(const [name,fn] of bindings)doc.defaultView.removeEventListener(name,fn,true);
        window.removeEventListener('pagehide',cancel);clearTimeout(timeout);banner.remove();outline.remove();cancelPicker=null;
        if(error)reject(error);else resolve(value);
      }
      const cancel=()=>finish(new Error('已取消点选'));
      function suppress(event){event.preventDefault();event.stopImmediatePropagation();}
      function key(event){suppress(event);if(event.key==='Escape')cancel();}
      function selection(target) {
        if(!target?.closest || target.closest(EXCLUDED))return null;
        if(kind==='sample') {
          if(!profile)throw new Error('请先识别或点选目录');
          if(profile.adapterId==='sangfor') {
            const {root}=context(profile);const row=target.closest('.x-tree-node-el');if(!row||!root.contains(row))return null;
            const path=[];for(let li=row.parentElement;li&&root.contains(li);li=li.parentElement?.closest('li.x-tree-node')) {const item=li.querySelector(':scope > .x-tree-node-el');if(item&&!item.classList.contains('x-tree-root'))path.unshift(space([...item.children].filter(el=>el.matches('span:not(.x-tree-node-indent)')).map(el=>el.textContent).join(' ')));}
            const found=globalThis.SangforTree?.scan({entry:profile.entry}).items.filter(item=>pathKey(item.locator.path)===pathKey(path));
            return found?.length===1?{target:row,chapter:found[0]}:null;
          }
          const state=inventory(profile);const found=state.records.filter(record=>record.target===target||record.target.contains(target));return found.length===1?{target:found[0].target,chapter:found[0].chapter}:null;
        }
        if(kind==='rotation') {
          const nav=target.closest(NAV);if(!nav||target.closest('article,form,[role="dialog"]'))return null;
          const el=target.closest(ACTION+',.ix-menu-item');if(!el||!nav.contains(el)||!visible(el)||blocked(el))return null;return {target:el};
        }
        let el;
        if(kind==='toc') {
          el=profile?.adapterId==='sangfor'?target.closest('.x-tree-root-ct'):target.closest(TOC+',ul,ol');
          // An unfamiliar directory often consists of sibling div tabs. Selecting
          // its label must select the containing directory, not one chapter.
          for(let parent=target,depth=0;!el&&parent&&depth<12;parent=parent.parentElement,depth++) {
            if(parent.matches('html,body,main,article,[role="main"]')||parent.closest(EXCLUDED))break;
            if(parent.matches('div,section')&&candidates(parent).length>=2)el=parent;
          }
        } else el=target.closest('article,main,[role="main"],section,div');
        if(!el||el.matches('html,body')||el.closest(EXCLUDED)||(kind==='toc'&&el.matches('main,article,[role="main"]')))return null;
        return {target:el};
      }
      function hover(event){try{const selected=selection(event.target);if(!selected)return;const rect=selected.target.getBoundingClientRect();const frame=documents.find(item=>item.doc===selected.target.ownerDocument)?.frameSelector;const offset=frame?unique(document,frame).getBoundingClientRect():{left:0,top:0};Object.assign(outline.style,{left:rect.left+offset.left+'px',top:rect.top+offset.top+'px',width:rect.width+'px',height:rect.height+'px'});}catch{}}
      function click(event) {
        suppress(event);
        try {
          const selected=selection(event.target);if(!selected){banner.textContent='该位置不符合要求，请选择已确认的'+(kind==='sample'?'目录章节':'区域')+'；Esc 取消';return;}
          const {target,chapter}=selected;const info=documents.find(item=>item.doc===target.ownerDocument);
          const value={selector:selectorFor(target),title:chapter?.title||titleOf(target).slice(0,200),url:chapter?.url||normalizeURL(location.href,profile||detect({}).profile),...(chapter?.locator?{locator:chapter.locator}:{}),...(info?.frameSelector?{frameSelector:info.frameSelector}:{})};
          if(kind==='toc'||kind==='content'){activeProfile={...(profile||detect({}).profile),[kind==='toc'?'tocSelector':'contentSelector']:value.selector};if(value.frameSelector)activeProfile.frameSelector=value.frameSelector;}
          finish(null,value);
        }catch(error){banner.textContent=error.message+'；Esc 取消';}
      }
      const timeout=setTimeout(()=>finish(new Error('点选超时，请重新开始')),120000);cancelPicker=cancel;
      for(const {doc} of documents)for(const [name,fn] of bindings)doc.defaultView.addEventListener(name,fn,{capture:true,passive:false});
      window.addEventListener('pagehide',cancel);
    });
  }
  globalThis.SecurityManualAdapters=Object.freeze({detect,normalizeURL,discover,open,verify,pick});
})();
