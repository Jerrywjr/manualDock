// Read-only navigation discovery and the shared validation used before every click.
(() => {
  'use strict';
  if (globalThis.SecurityNavigationDiscovery) return;
  const overlayId = 'security-navigation-rotation';
  const semantic =
    'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],[role="tree"]';
  const actions = 'a,button,[role="tab"],[role="menuitem"],[role="treeitem"]';
  const forbidden =
    'form,input,textarea,select,option,[form],[role="dialog"],article,pre,code,table,.markdown-body,.article-content,.document-content,[role="document"],[contenteditable]:not([contenteditable="false"])';
  const disabled =
    '[disabled],[aria-disabled="true"],[inert],.is-disabled,.disabled,.ix-menu-item-disabled,.x-item-disabled';
  const dangerous =
    /保存|下发|提交|删除|清空|重置|恢复出厂|重启|关机|注销|登出|退出登录|立即执行|立即应用|确认操作|新增|新建|添加|save|apply|submit|delete|remove|commit|execute|reboot|shutdown|reset|restart|logout|logoff|signout|deploy|factory|(?:^|[\s_-])(?:add|create|publish|install)(?:$|[\s_-])/i;
  const menuClass = /(?:^|[\s_-])(?:nav(?:igation|bar)?|menu|menubar|tabstrip|tabs?)(?:$|[\s_-])/i;
  const itemClass =
    /(?:^|[\s_-])(?:menu|nav|navigation|tab)[_-]?(?:item|link|entry)(?:$|[\s_-])|(?:^|[\s_-])tab(?:$|[\s_-])/i;
  const clean = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const classes = (element) => clean(element.getAttribute('class'));

  function visible(element) {
    if (
      !element?.isConnected ||
      !element.getClientRects().length ||
      element.closest('[hidden],[aria-hidden="true"],[inert]')
    )
      return false;
    for (let current = element, depth = 0; current; current = current.parentElement) {
      if (++depth > 100) return false;
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        /^(hidden|collapse)$/.test(style.visibility) ||
        style.opacity === '0'
      )
        return false;
    }
    return true;
  }
  function isContainer(element) {
    if (element.matches(semantic)) return true;
    const hint = classes(element) + ' ' + (element.getAttribute('id') || '');
    return (
      !element.matches(actions) &&
      !itemClass.test(hint) &&
      menuClass.test(hint) &&
      element.children.length >= 2
    );
  }
  function navigationFor(element) {
    for (
      let current = element.parentElement, depth = 0;
      current && depth++ < 100;
      current = current.parentElement
    ) {
      if (isContainer(current)) return current;
    }
    return null;
  }
  function label(element) {
    let result = '',
      visited = 0,
      node = element.firstChild;
    while (node && visited++ < 300 && result.length <= 240) {
      const skip =
        node.nodeType === 1 &&
        (node.matches('script,style,noscript,template,' + forbidden) || !visible(node));
      if (node.nodeType === 3) result += node.nodeValue || '';
      if (!skip && node.firstChild) {
        node = node.firstChild;
        continue;
      }
      while (node && node !== element && !node.nextSibling) node = node.parentNode;
      node = node && node !== element ? node.nextSibling : null;
    }
    if (node || result.length > 240) throw new Error('导航标题过长或结构过于复杂，轮换已停止。');
    return clean(result);
  }
  function inScope(raw, scope) {
    try {
      const url = new URL(raw, location.href),
        prefix = scope.pathPrefix;
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin === scope.origin &&
        !url.username &&
        !url.password &&
        typeof prefix === 'string' &&
        prefix.startsWith('/') &&
        (prefix === '/' ||
          url.pathname === prefix ||
          url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
      );
    } catch {
      return false;
    }
  }
  function safeLink(anchor, scope) {
    if (
      anchor.hasAttribute('download') ||
      (anchor.getAttribute('target') && anchor.getAttribute('target') !== '_self')
    )
      return false;
    const raw = (anchor.getAttribute('href') || '').trim();
    if (/^javascript:\s*(?:void\(0\);?|;)$/i.test(raw)) return true;
    if (!inScope(raw, scope)) return false;
    try {
      const url = new URL(raw, location.href),
        route = decodeURIComponent(url.pathname + url.hash);
      if (
        /(?:^|[\/#_.?=&-])(?:log[-_]?out|log[-_]?off|sign[-_]?out|delete|remove|save|apply|submit|commit|execute|reboot|shutdown|reset|restart|deploy|install|create|publish)(?:$|[\/#_.?=&-])|保存|下发|提交|删除|清空|重置|重启|关机|注销|登出|退出登录/i.test(
          route,
        )
      )
        return false;
      const querySets = [url.searchParams];
      if (url.hash.includes('?'))
        querySets.push(new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)));
      for (const query of querySets)
        for (const key of query.keys())
          if (
            /^(?:action|cmd|command|op|operation|do|token|password|passwd|secret|authorization|access_token|sessionid)$/i.test(
              key,
            )
          )
            return false;
      return true;
    } catch {
      return false;
    }
  }
  function inspect(element, scope) {
    const navigation = navigationFor(element);
    if (
      !navigation ||
      element.closest(forbidden) ||
      element.closest('#' + overlayId) ||
      element.querySelector(
        'form,input,textarea,select,[contenteditable]:not([contenteditable="false"])',
      )
    )
      throw new Error('选中项不是独立的明确导航，或位于表单、正文区域，轮换已停止。');
    const main = element.closest('main,[role="main"]');
    if (main && navigation.contains(main)) throw new Error('选中项位于正文区域，轮换已停止。');
    let control = element.closest(actions) || element;
    if (control === element && !element.matches(actions)) {
      const children = [...element.querySelectorAll(actions)].filter(visible);
      if (children.length > 1) throw new Error('所选导航项包含多个可点击控件，轮换已停止。');
      if (children.length === 1) control = children[0];
      else if (!element.matches('li,[tabindex]') && !itemClass.test(classes(element)))
        throw new Error('无法确定该节点是导航控件，请点选实际菜单项。');
    }
    if (
      !navigation.contains(control) ||
      control.closest(forbidden) ||
      control.closest(disabled) ||
      !visible(control)
    )
      throw new Error('导航控件不可用，轮换已停止。');
    if ([...control.querySelectorAll(actions)].some(visible))
      throw new Error('所选导航项包含嵌套的操作控件，轮换已停止。');
    const title = label(control);
    const hints = [
      title,
      control.getAttribute('id'),
      control.getAttribute('title'),
      control.getAttribute('aria-label'),
      classes(control),
    ].join(' ');
    if (!title || title.length > 120 || dangerous.test(hints))
      throw new Error('选中项可能是保存、下发或其他操作控件，轮换已停止。');
    const anchor = control.closest('a[href]');
    if (anchor && !safeLink(anchor, scope))
      throw new Error('导航链接超出范围或带有操作用途，轮换已停止。');
    if (typeof control.click !== 'function') throw new Error('导航控件无法点击，轮换已停止。');
    return { control, navigation, title };
  }
  function resolveTargets(config) {
    if (!config || !Array.isArray(config.targets) || !inScope(location.href, config))
      throw new Error('已离开指定站点或路径范围，轮换已停止。');
    const resolved = new Set();
    return config.targets.map((selection) => {
      let matches;
      try {
        matches = [...document.querySelectorAll(selection.selector)].filter(
          (element) => !element.closest('#' + overlayId) && visible(element),
        );
      } catch {
        throw new Error('导航选择器无效或无法读取，轮换已停止。');
      }
      if (matches.length !== 1) throw new Error('导航项无法唯一定位为一个可见节点，轮换已停止。');
      const { control, title } = inspect(matches[0], config);
      if (title !== selection.title)
        throw new Error('导航标题已变化，轮换已停止；请重新点选目标。');
      if (resolved.has(control)) throw new Error('导航目标重复，轮换已停止。');
      resolved.add(control);
      return control;
    });
  }
  function selectorFor(element) {
    const parts = [];
    for (
      let current = element, depth = 0;
      current && depth++ < 16;
      current = current.parentElement
    ) {
      const id = current.getAttribute('id');
      if (
        id &&
        /^[a-zA-Z_][\w-]{0,79}$/.test(id) &&
        document.querySelectorAll('#' + id).length === 1
      ) {
        parts.unshift('#' + id);
        break;
      }
      const tag = current.localName;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((node) => node.localName === tag)
        : [current];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    const result = parts.join(' > ');
    if (result.length > 512 || document.querySelectorAll(result).length !== 1)
      throw new Error('无法生成唯一的导航定位方式。');
    return result;
  }
  function pathScope(controls) {
    const paths = [location.pathname];
    for (const control of controls) {
      const anchor = control.closest('a[href]'),
        raw = anchor?.getAttribute('href');
      if (raw && !/^javascript:/i.test(raw)) paths.push(new URL(raw, location.href).pathname);
    }
    if (paths.every((path) => path === paths[0])) return paths[0];
    const split = paths.map((path) => path.split('/')),
      common = [];
    for (let i = 1; i < split[0].length - 1; i++) {
      if (!split.every((parts) => parts[i] === split[0][i])) break;
      common.push(split[0][i]);
    }
    return '/' + common.join('/') + (common.length ? '/' : '');
  }
  function discover() {
    const warnings = [],
      scope = { origin: location.origin, pathPrefix: '/' };
    const diagnostics = {
      scannedElements: 0,
      navigationGroups: 0,
      safeCandidates: 0,
      excludedCandidates: 0,
      duplicateLabels: 0,
    };
    const empty = (message) => ({
      ...scope,
      targets: [],
      confidence: 'none',
      warnings: [...warnings, message],
      diagnostics,
    });
    if (!/^https?:$/.test(location.protocol) || !inScope(location.href, scope))
      return empty('请在已登录的管理页面识别或点选主菜单。');
    const candidates = [...document.querySelectorAll(semantic + ',[class],[id]')];
    diagnostics.scannedElements = Math.min(candidates.length, 10000);
    if (candidates.length > 10000)
      warnings.push('页面结构超过识别上限，仅检查前 10000 个节点；可点选实际导航。');
    const groups = [],
      signatures = new Map();
    for (const navigation of candidates.slice(0, 10000)) {
      if (
        !isContainer(navigation) ||
        !visible(navigation) ||
        navigation.closest(forbidden) ||
        navigation.closest('#' + overlayId)
      )
        continue;
      diagnostics.navigationGroups++;
      const nodes = [...navigation.querySelectorAll(actions + ',li,[tabindex],[class]')].slice(
        0,
        500,
      );
      const found = new Map();
      for (const node of nodes) {
        if (
          !visible(node) ||
          (!node.matches(actions + ',li,[tabindex]') && !itemClass.test(classes(node)))
        )
          continue;
        // A nested menu is considered independently, so a parent cannot absorb it.
        if (navigationFor(node) !== navigation) continue;
        try {
          const result = inspect(node, scope);
          found.set(result.control, result);
        } catch {
          diagnostics.excludedCandidates++;
        }
      }
      let items = [...found.values()];
      const counts = new Map();
      for (const item of items) counts.set(item.title, (counts.get(item.title) || 0) + 1);
      const duplicated = items.filter((item) => counts.get(item.title) > 1).length;
      if (duplicated) {
        diagnostics.duplicateLabels += duplicated;
        warnings.push('识别到重名导航，已排除这些自动候选；需要时请逐一点选核对。');
      }
      items = items.filter((item) => counts.get(item.title) === 1);
      if (items.length < 2) continue;
      let targets;
      try {
        targets = items.map((item) => ({ selector: selectorFor(item.control), title: item.title }));
      } catch {
        continue;
      }
      const semanticGroup = navigation.matches(semantic);
      let score = semanticGroup ? 80 : 60;
      if (navigation.closest('header,[role="banner"]')) score += 20;
      if (navigation.matches('[role="menubar"],[role="navigation"]')) score += 5;
      if (/primary|main|主导航|主菜单/i.test(navigation.getAttribute('aria-label') || ''))
        score += 10;
      if (navigation.matches('[role="tree"]')) score -= 10;
      const signature = targets
        .map((target) => target.selector)
        .sort()
        .join('\n');
      const existing = signatures.get(signature);
      if (existing && existing.score >= score) continue;
      if (existing) groups.splice(groups.indexOf(existing), 1);
      const group = { items, targets, score, semanticGroup };
      signatures.set(signature, group);
      groups.push(group);
    }
    groups.sort((a, b) => b.score - a.score);
    if (!groups.length) return empty('未找到至少两个可靠的主菜单；请点选导航菜单后试运行。');
    if (groups[1] && groups[0].score - groups[1].score < 10)
      return empty('存在多组同样可信的导航，无法确定主菜单；请点选所需菜单后试运行。');
    const chosen = groups[0];
    diagnostics.safeCandidates = chosen.targets.length;
    if (chosen.targets.length > 6)
      warnings.push('已选择这组导航的前 6 项；可按实际需求调整顺序和数量。');
    const targets = chosen.targets.slice(0, 6);
    const config = {
      origin: location.origin,
      pathPrefix: pathScope(chosen.items.map((item) => item.control)),
      targets,
    };
    try {
      resolveTargets(config);
    } catch {
      return empty('页面导航在识别期间发生变化；请重新识别或点选菜单。');
    }
    return {
      ...config,
      confidence: chosen.semanticGroup ? 'high' : 'medium',
      warnings: [...new Set(warnings)],
      diagnostics,
    };
  }
  globalThis.SecurityNavigationDiscovery = Object.freeze({ discover, resolveTargets });
})();
