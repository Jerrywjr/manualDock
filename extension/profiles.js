const sensitive =
  /(?:password|passwd|secret|token|authorization|cookie|session|credential|ticket|csrf|api[_-]?key|^sid$|^jwt$)/i;
export function normalizeDocumentURL(raw, profile, base = profile?.entry) {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw.trim().replace(/&amp;/gi, '&'), base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== profile.origin
    )
      return null;
    const prefix = profile.pathPrefix || '/';
    if (!(
      prefix === '/' ||
      url.pathname === prefix ||
      url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
    ))
      return null;
    if (
      /\/(?:logout|logoff|delete|remove|save|commit|apply|execute|reboot|shutdown)(?:[./_-]|$)/i.test(
        url.pathname,
      )
    )
      return null;
    if (
      [...url.searchParams.keys()].some(
        (key) => sensitive.test(key) || !(profile.queryKeys || []).includes(key),
      )
    )
      return null;
    if (profile.hashMode !== 'route') url.hash = '';
    else {
      // Decode route query keys exactly as ordinary URL queries before storing them.
      const queryStart = url.hash.search(/[?&]/);
      if (
        queryStart !== -1 &&
        [...new URLSearchParams(url.hash.slice(queryStart + 1)).keys()].some((key) =>
          sensitive.test(key),
        )
      )
        return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
export function validateProfile(value) {
  if (!value || value.schemaVersion !== 1 || !['generic', 'sangfor'].includes(value.adapterId))
    throw new Error('配置格式或适配器无效');
  const url = new URL(value.entry);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('手册地址无效');
  const prefix = String(value.pathPrefix || '/');
  if (!prefix.startsWith('/') || prefix.includes('..') || /[?#\\\u0000-\u001f]/.test(prefix))
    throw new Error('手册范围必须是路径前缀');
  const keys = value.queryKeys || [];
  if (
    !Array.isArray(keys) ||
    keys.length > 60 ||
    keys.some(
      (key) => typeof key !== 'string' || !/^[\w.-]{1,80}$/.test(key) || sensitive.test(key),
    )
  )
    throw new Error('配置包含不支持的参数或认证字段');
  for (const name of ['tocSelector', 'contentSelector', 'frameSelector']) {
    if (value[name] != null && (typeof value[name] !== 'string' || value[name].length > 1000))
      throw new Error('页面定位规则无效');
  }
  const profile = {
    schemaVersion: 1,
    id: String(value.id || crypto.randomUUID()),
    revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
    name: String(value.name || '我的手册').slice(0, 120),
    adapterId: value.adapterId,
    entry: url.href,
    origin: url.origin,
    pathPrefix: prefix,
    hashMode: ['route', 'anchor', 'none'].includes(value.hashMode) ? value.hashMode : 'none',
    queryKeys: [...new Set(keys)],
    tocSelector: value.tocSelector || '',
    contentSelector: value.contentSelector || '',
    navigation: value.navigation === 'click' ? 'click' : 'links',
    samples: [],
  };
  if (value.frameSelector) profile.frameSelector = value.frameSelector;
  profile.entry = normalizeDocumentURL(profile.entry, profile);
  if (!profile.entry) throw new Error('入口不在配置范围内，或包含未允许的参数');
  if (value.samples != null && (!Array.isArray(value.samples) || value.samples.length > 2))
    throw new Error('示例章节数量无效');
  for (const sample of value.samples || []) {
    const chapter = cleanChapter(sample, profile);
    if (!chapter) throw new Error('示例章节不在手册范围内');
    profile.samples.push(chapter);
  }
  return profile;
}
export function cleanChapter(value, profile) {
  if (!value || typeof value !== 'object') return null;
  const url = normalizeDocumentURL(value.url, profile);
  if (!url || typeof value.title !== 'string' || value.title.length > 500) return null;
  const result = { key: 'url:' + url, url, title: value.title };
  if (value.locator) {
    const l = value.locator;
    if (
      !['generic-toc', 'sangfor-ext-tree'].includes(l.kind) ||
      !Array.isArray(l.path) ||
      !l.path.length ||
      l.path.length > 12 ||
      l.path.some((s) => typeof s !== 'string' || !s.trim() || s.length > 200)
    )
      return null;
    result.locator = { kind: l.kind, path: [...l.path] };
    if (typeof l.selector === 'string' && l.selector.length <= 1000)
      result.locator.selector = l.selector;
    if (typeof l.nodeId === 'string' && /^[\w:.-]{1,200}$/.test(l.nodeId))
      result.locator.nodeId = l.nodeId;
    result.key = 'toc:' + encodeURIComponent(JSON.stringify([l.kind, l.path, l.nodeId || '']));
  }
  return result;
}
export function jobKey(profile, product, version) {
  return JSON.stringify([
    profile.origin,
    profile.entry,
    profile.id,
    profile.revision,
    product || '未知',
    version || '未知',
  ]);
}
export function exportProfile(profile) {
  return JSON.stringify(validateProfile(profile), null, 2);
}

export function ruleSignature(profile) {
  return JSON.stringify(
    [
      'entry',
      'origin',
      'pathPrefix',
      'adapterId',
      'hashMode',
      'queryKeys',
      'tocSelector',
      'contentSelector',
      'navigation',
      'frameSelector',
    ].map((key) => profile[key] ?? null),
  );
}
export function reviseProfile(profile, changes) {
  const candidate = validateProfile({ ...profile, ...changes, samples: [] });
  if (ruleSignature(candidate) === ruleSignature(profile))
    return validateProfile({ ...candidate, samples: profile.samples || [] });
  return { ...candidate, id: crypto.randomUUID(), revision: 1, samples: [] };
}
export function bindProfile(value, currentURL) {
  const imported = validateProfile(value),
    url = new URL(currentURL),
    previous = new URL(imported.entry);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) => sensitive.test(key))
  )
    throw new Error('当前页面地址包含认证信息或不受支持');
  const oldScope = imported.pathPrefix;
  const compatible =
    oldScope === '/' ||
    url.pathname === oldScope ||
    url.pathname.startsWith(oldScope.endsWith('/') ? oldScope : oldScope + '/');
  const pathPrefix =
    oldScope === previous.pathname
      ? url.pathname
      : compatible
        ? oldScope
        : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/';
  return validateProfile({
    ...imported,
    id: crypto.randomUUID(),
    revision: 1,
    entry: url.href,
    origin: url.origin,
    pathPrefix,
    queryKeys: [...new Set([...imported.queryKeys, ...url.searchParams.keys()])],
    samples: [],
  });
}
export function specificationURL(raw, currentURL) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请填写同源规范文档地址');
  const current = new URL(currentURL),
    url = new URL(raw, current);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== current.origin ||
    url.username ||
    url.password
  )
    throw new Error('规范地址必须是当前网站同源的 HTTP/HTTPS 地址，且不含认证信息');
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new Error('规范地址编码无效');
  }
  if (
    /(?:^|[\/_.-])(?:logout|logoff|signout|delete|remove|save|commit|apply|execute|reboot|shutdown|reset|restart|deploy)(?:[\/_.-]|$)/i.test(
      path,
    ) ||
    [...url.searchParams.keys()].some(
      (key) => sensitive.test(key) || /^(?:action|cmd|command|op|operation|do)$/i.test(key),
    )
  )
    throw new Error('规范地址不能包含认证参数或管理操作');
  url.hash = '';
  return url.href;
}
export function specificationTaskId(hash, source, product, version) {
  return JSON.stringify(['spec', source, hash, product || '未知', version || '未知']);
}

/** Reuse chapter rules only within the current manual, never merely its host. */
export function profilesForSource(currentURL, savedProfiles) {
  let current;
  try {
    current = new URL(currentURL);
  } catch {
    return [];
  }
  return savedProfiles.filter((profile) => {
    if (!normalizeDocumentURL(currentURL, profile)) return false;
    const entry = new URL(profile.entry);
    if (current.pathname === entry.pathname) return true;
    // Root-scoped legacy rules cannot prove that two different page routes
    // describe one manual. Explicit subdirectory scopes can span chapter files.
    if (profile.adapterId === 'sangfor' || !profile.pathPrefix || profile.pathPrefix === '/')
      return false;
    return true;
  });
}

export function selectSavedProfile(currentURL, savedProfiles, tasks = []) {
  const candidates = [];
  for (const profile of savedProfiles) {
    const current = normalizeDocumentURL(currentURL, profile),
      entry = normalizeDocumentURL(profile.entry, profile);
    if (!current || !entry) continue;
    const related = tasks.filter(
      (task) =>
        task.sourceKind === 'web' &&
        task.profileId === profile.id &&
        task.profileRevision === profile.revision &&
        task.profile?.id === profile.id &&
        task.profile?.revision === profile.revision &&
        ruleSignature(task.profile) === ruleSignature(profile) &&
        normalizeDocumentURL(task.entry, profile) === entry &&
        task.taskId === jobKey(profile, task.product, task.version),
    );
    const known =
      current === entry ||
      (profile.samples || []).some(
        (chapter) => normalizeDocumentURL(chapter.url, profile) === current,
      ) ||
      related.some((task) =>
        (task.queue || []).some(
          (chapter) => normalizeDocumentURL(chapter.url, profile) === current,
        ),
      );
    if (known) candidates.push({ profile, tasks: related });
  }
  if (!candidates.length) return { status: 'none' };
  if (candidates.length === 1 && candidates[0].tasks.length <= 1)
    return {
      status: 'selected',
      profile: candidates[0].profile,
      task: candidates[0].tasks[0] || null,
    };
  const recent = candidates
    .flatMap((candidate) =>
      candidate.tasks.map((task) => ({
        profile: candidate.profile,
        task,
        time: Date.parse(task.updatedAt),
      })),
    )
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  if (recent.length && (!recent[1] || recent[0].time > recent[1].time))
    return { status: 'selected', profile: recent[0].profile, task: recent[0].task };
  return { status: 'ambiguous', profiles: candidates.map((candidate) => candidate.profile) };
}
