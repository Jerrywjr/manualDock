const connections = new WeakMap();

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

/** Keep navigation identity separate from Chrome's scheme/host permission pattern. */
export function parseSourceURL(raw) {
  if (typeof raw !== 'string' || !raw.trim())
    throw failure('INVALID_URL', '请填写完整的 HTTP/HTTPS 页面地址');
  const value = raw.trim();
  if (/[\u0000-\u0020\u007f]/.test(value))
    throw failure('INVALID_URL', '页面地址不能包含空格或控制字符');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw failure('INVALID_URL', '页面地址无效，请填写完整的 HTTP/HTTPS 网址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw failure('INVALID_URL', '只支持 HTTP/HTTPS 页面地址');
  if (parsed.hostname.includes('*'))
    throw failure('INVALID_URL', '页面地址必须指定一个网站，不能包含通配符主机名');
  if (parsed.username || parsed.password)
    throw failure('INVALID_URL', '页面地址不能包含账号或密码，请先在浏览器中登录');
  return {
    url: parsed.href,
    origin: parsed.origin,
    permissionOrigin: `${parsed.protocol}//${parsed.hostname}/*`,
  };
}

/** Known entry routes determine their purpose; unfamiliar sites keep the user's choice. */
export function resolveSourcePurpose(raw, fallback = 'document') {
  try {
    const url = new URL(parseSourceURL(raw).url);
    if (url.pathname === '/adocs.php' || url.pathname === '/cdocs.php') return 'document';
    if (url.pathname === '/framework.php') return 'rotation';
  } catch {
    // Classification grants nothing; the connector or session validates the source itself.
  }
  return fallback;
}

function sameURL(raw, expected) {
  try {
    return new URL(raw).href === expected;
  } catch {
    return false;
  }
}

// Known manual chapter parameters change during collection without changing
// the source document. Keep all other URL identities exact.
function connectionKey(raw) {
  try {
    const url = new URL(parseSourceURL(raw).url);
    const pairs = [...url.searchParams];
    const chapter =
      pairs.length === 2 &&
      url.searchParams.getAll('index').length === 1 &&
      url.searchParams.getAll('dataID').length === 1 &&
      /^\d+$/.test(url.searchParams.get('index')) &&
      /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('dataID'));
    if (/^\/(?:adocs|cdocs)\.php$/.test(url.pathname) && !url.hash && (!pairs.length || chapter))
      return url.origin + url.pathname;
    return url.href;
  } catch {
    return null;
  }
}

function waitForLoadedTab(tab, source, chrome, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let latest = tab;
    let timer;
    const clean = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clean();
      if (error) reject(error);
      else resolve(value);
    };
    const inspect = (current) => {
      if (settled) return;
      // Chrome hides a redirected site's URL when that origin was not granted.
      // Never treat the previous permitted URL as proof of the completed page.
      if (current.status === 'complete' && !current.url)
        return finish(
          failure(
            'SOURCE_REDIRECTED',
            '无法确认加载后页面仍在已授权网站，请粘贴当前页面地址重新连接',
          ),
        );
      latest = { ...latest, ...current };
      const address = latest.url || '';
      if (/^chrome-error:\/\//i.test(address) || latest.discarded)
        return finish(failure('LOAD_FAILED', '来源页面加载失败，请在浏览器中检查后重新连接'));
      let actual;
      try {
        actual = new URL(address);
      } catch {
        /* A newly created tab may have no URL yet. */
      }
      if (
        actual &&
        ['http:', 'https:'].includes(actual.protocol) &&
        actual.origin !== source.origin
      )
        return finish(
          failure('SOURCE_REDIRECTED', '页面已跳转到其他网站，请粘贴目标页面地址重新连接'),
        );
      if (latest.status !== 'complete') return;
      if (!actual || !['http:', 'https:'].includes(actual.protocol))
        return finish(failure('LOAD_FAILED', '来源页面未加载为 HTTP/HTTPS 文档，请检查后重新连接'));
      finish(null, latest);
    };
    const updated = (id, change, current) => {
      if (id !== tab.id) return;
      inspect({ ...current, ...change, id });
    };
    const removed = (id) => {
      if (id === tab.id) finish(failure('TAB_CLOSED', '来源标签页已关闭，请重新连接'));
    };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    timer = setTimeout(
      () => finish(failure('LOAD_TIMEOUT', '等待来源页面加载超时；标签页已保留，请检查后重新连接')),
      timeoutMs,
    );
    // Subscribe before re-reading so a completion between query/create and get
    // is observed. A late get result cannot change an already settled outcome.
    Promise.resolve()
      .then(() => chrome.tabs.get(tab.id))
      .then(inspect, (error) => {
        finish(failure('TAB_CLOSED', '无法读取来源标签页，页面可能已关闭，请重新连接', error));
      });
  });
}

async function connectGranted(source, chrome, timeoutMs, preferredTabIds, canCreate) {
  let tab;
  try {
    const available = (await chrome.tabs.query({ url: source.permissionOrigin })).filter((tab) =>
      Number.isInteger(tab.id),
    );
    const exact = available.filter((tab) => sameURL(tab.url, source.url));
    const key = connectionKey(source.url);
    const equivalent = available.filter((tab) => connectionKey(tab.url) === key);
    // A controlled chapter may have navigated since its entry URL was pasted.
    // Reuse that owner before considering an unregistered duplicate tab.
    const controlled = equivalent.filter((tab) => preferredTabIds.includes(tab.id));
    const matches = controlled.length ? controlled : exact.length ? exact : equivalent;
    tab = matches.find((tab) => tab.status === 'complete') || matches[0];
    if (!tab) {
      if (!(await canCreate()))
        throw failure(
          'SOURCE_LIMIT',
          '最多同时连接 8 个来源；请关闭不用的来源标签页，或暂停后在工作台移除来源。',
        );
      tab = await chrome.tabs.create({ url: source.url, active: false });
    }
  } catch (error) {
    if (error.code === 'SOURCE_LIMIT') throw error;
    throw failure('LOAD_FAILED', '无法打开来源页面，请检查浏览器状态后重新连接', error);
  }
  if (!Number.isInteger(tab?.id)) throw failure('LOAD_FAILED', '浏览器没有返回可连接的来源标签页');
  return waitForLoadedTab(tab, source, chrome, timeoutMs);
}

/** Connect only. Recognition, discovery and capture belong to the workspace. */
export async function connectSourceURL(
  raw,
  {
    chrome = globalThis.chrome,
    timeoutMs = 15000,
    preferredTabIds = [],
    canCreate = () => true,
  } = {},
) {
  const source = parseSourceURL(raw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)
    throw failure('INVALID_TIMEOUT', '页面加载等待时间必须在 1 至 120000 毫秒之间');
  let permission;
  try {
    // Do not move this call behind an await: Chrome requires the click gesture.
    permission = chrome.permissions.request({ origins: [source.permissionOrigin] });
  } catch (error) {
    throw failure('PERMISSION_FAILED', '无法完成此网站授权，请重试连接', error);
  }
  let granted;
  try {
    granted = await permission;
  } catch (error) {
    throw failure('PERMISSION_FAILED', '此网站授权失败，请重试连接', error);
  }
  if (!granted) throw failure('PERMISSION_DENIED', '未获得此网站的访问权限，尚未连接来源');

  let pending = connections.get(chrome);
  if (!pending) {
    pending = new Map();
    connections.set(chrome, pending);
  }
  const key = connectionKey(source.url);
  if (pending.has(key)) return pending.get(key);
  const connection = connectGranted(source, chrome, timeoutMs, preferredTabIds, canCreate);
  pending.set(key, connection);
  try {
    return await connection;
  } finally {
    if (pending.get(key) === connection) pending.delete(key);
  }
}
