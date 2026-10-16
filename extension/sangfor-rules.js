const DEFAULT_ENTRY = 'https://manual.example.test/adocs.php';
/** Only safe manual navigation URLs are accepted; query parameters are never silently dropped. */
export function normalizeURL(raw, entry = DEFAULT_ENTRY) {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const base = new URL(entry);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const url = new URL(raw.trim().replace(/&amp;/gi, '&'), base);
    if (
      url.username ||
      url.password ||
      url.origin !== base.origin ||
      url.pathname !== base.pathname
    )
      return null;
    const parameters = [...url.searchParams.entries()];
    if (!parameters.length) {
      if (url.hash) return null;
      url.search = '';
      return url.href;
    }
    if (
      parameters.length !== 2 ||
      url.searchParams.getAll('index').length !== 1 ||
      url.searchParams.getAll('dataID').length !== 1
    )
      return null;
    const index = url.searchParams.get('index');
    const dataID = url.searchParams.get('dataID');
    if (!/^\d+$/.test(index) || !/^[A-Za-z0-9_-]+$/.test(dataID)) return null;
    url.hash = '';
    url.search = `?index=${index.replace(/^0+(?=\d)/, '')}&dataID=${dataID}`;
    return url.href;
  } catch {
    return null;
  }
}

export function chapterKey(item) {
  return item.key || item.url;
}

/** A locator describes an observed menu path, never a script or a guessed URL. */
export function validateLocator(value) {
  if (
    !value ||
    value.kind !== 'sangfor-ext-tree' ||
    !Array.isArray(value.path) ||
    value.path.length < 1 ||
    value.path.length > 12 ||
    value.path.some(
      (part) =>
        typeof part !== 'string' ||
        !part.trim() ||
        part.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(part),
    ) ||
    (value.nodeId !== undefined &&
      (typeof value.nodeId !== 'string' || !/^api-menu-item\d+$/.test(value.nodeId)))
  )
    return null;
  return {
    kind: value.kind,
    path: [...value.path],
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
  };
}

const locatorKey = (locator) => `toc:${encodeURIComponent(JSON.stringify(locator.path))}`;

/** Existing records retain progress; discovery supplies validated identities and titles. */
export function mergeLinks(existing = [], found = [], entry = DEFAULT_ENTRY) {
  const result = [];
  const seen = new Map();
  const paths = new Map();
  const legacyTitles = new Map();
  for (const [records, preserveState] of [
    [existing, true],
    [found, false],
  ]) {
    for (const record of records ?? []) {
      const url = normalizeURL(typeof record === 'string' ? record : record?.url, entry);
      if (!url) continue;
      const locator = record?.locator === undefined ? null : validateLocator(record.locator);
      if (record?.locator !== undefined && !locator) continue;
      const title = typeof record?.title === 'string' ? record.title.trim() : '';
      const pathKey = locator && locatorKey(locator);
      const key = preserveState && record?.key ? record.key : pathKey || url;
      const previous = (pathKey && paths.get(pathKey)) || seen.get(key);
      if (previous) {
        if (!previous.title.trim() && title) previous.title = title;
        continue;
      }
      // A unique, complete numbered title can gain a locator while retaining
      // the URL key of its already saved page in archives from older releases.
      const matching =
        !preserveState &&
        locator &&
        /^\d+(?:\.\d+)*(?:[.、\s]|(?=[^\d.]))/.test(title) &&
        title === locator.path.at(-1) &&
        legacyTitles.get(title);
      if (matching?.length === 1 && !matching[0].locator) {
        const item = matching[0];
        item.key = chapterKey(item);
        item.locator = locator;
        paths.set(pathKey, item);
        continue;
      }
      const item =
        preserveState && typeof record === 'object'
          ? { ...record, url, title }
          : { url: locator ? normalizeURL(entry, entry) : url, title };
      if (locator) {
        item.locator = locator;
        item.key = key;
        paths.set(pathKey, item);
      }
      seen.set(key, item);
      result.push(item);
      if (preserveState && !locator) {
        if (!legacyTitles.has(title)) legacyTitles.set(title, []);
        legacyTitles.get(title).push(item);
      }
    }
  }
  return result;
}
