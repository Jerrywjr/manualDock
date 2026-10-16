import test from 'node:test';
import assert from 'node:assert/strict';
let parseSourceURL, connectSourceURL, resolveSourcePurpose;
try {
  ({ parseSourceURL, connectSourceURL, resolveSourcePurpose } =
    await import('../extension/source-connector.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function setup(t, { tabs = [], permission = true } = {}) {
  assert.equal(typeof connectSourceURL, 'function', 'URL connection must be implemented');
  const updated = new Set(),
    removed = new Set(),
    records = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const calls = { permissions: [], queries: [], creates: [], gets: [], removed: [], scripts: [] };
  let nextId = 50;
  const event = (set) => ({
    addListener: (fn) => set.add(fn),
    removeListener: (fn) => set.delete(fn),
  });
  const chrome = {
    permissions: {
      request: (request) => {
        calls.permissions.push(request);
        return typeof permission === 'function' ? permission(request) : Promise.resolve(permission);
      },
    },
    tabs: {
      query: async (query) => {
        calls.queries.push(query);
        return [...records.values()];
      },
      create: async (options) => {
        calls.creates.push(options);
        const tab = { id: nextId++, url: options.url, status: 'loading' };
        records.set(tab.id, tab);
        return tab;
      },
      get: async (id) => {
        calls.gets.push(id);
        if (!records.has(id)) throw new Error('No tab with id');
        return { ...records.get(id) };
      },
      remove: async (id) => {
        calls.removed.push(id);
        records.delete(id);
      },
      onUpdated: event(updated),
      onRemoved: event(removed),
    },
    scripting: { executeScript: async (script) => calls.scripts.push(script) },
  };
  const update = (id, change) => {
    const tab = { ...records.get(id), ...change, id };
    records.set(id, tab);
    for (const callback of updated) callback(id, change, tab);
  };
  const close = (id) => {
    records.delete(id);
    for (const callback of removed) callback(id, { isWindowClosing: false });
  };
  t.after(() => {
    assert.equal(updated.size, 0, 'load listeners must be cleaned up');
    assert.equal(removed.size, 0, 'close listeners must be cleaned up');
  });
  return { chrome, calls, records, update, close, updated, removed };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(condition) {
  for (let n = 0; n < 30 && !condition(); n++) await tick();
  assert.ok(condition(), 'expected connector checkpoint');
}

test('parse keeps complete URL identity while host permission excludes port, query and fragment', () => {
  assert.equal(typeof parseSourceURL, 'function');
  assert.deepEqual(parseSourceURL(' HTTPS://Example.test:8443/docs?q=one#chapter '), {
    url: 'https://example.test:8443/docs?q=one#chapter',
    origin: 'https://example.test:8443',
    permissionOrigin: 'https://example.test/*',
  });
  for (const value of [
    '',
    '   ',
    null,
    'file:///tmp/manual.html',
    'javascript:alert(1)',
    'chrome-extension://id/panel.html',
    'https://user:pass@example.test/manual',
  ]) {
    assert.throws(() => parseSourceURL(value), /地址|HTTP|网址|账号|密码/);
  }
});

test('permission request happens synchronously and denial never queries or creates a tab', async (t) => {
  const p = setup(t, { permission: false });
  const pending = connectSourceURL('https://manual.test:8443/docs?q=1#part', { chrome: p.chrome });
  assert.deepEqual(p.calls.permissions, [{ origins: ['https://manual.test/*'] }]);
  await assert.rejects(pending, (error) => error.code === 'PERMISSION_DENIED');
  assert.equal(p.calls.queries.length, 0);
  assert.equal(p.calls.creates.length, 0);
});

test('permission API exceptions never query, open, or inject a page', async (t) => {
  const p = setup(t, {
    permission: () => {
      throw new Error('permission API unavailable');
    },
  });
  await assert.rejects(
    connectSourceURL('https://manual.test/docs', { chrome: p.chrome }),
    (error) => error.code === 'PERMISSION_FAILED',
  );
  assert.equal(p.calls.queries.length, 0);
  assert.equal(p.calls.creates.length, 0);
  assert.equal(p.calls.scripts.length, 0);
});

test('only an exact full URL is reused and no existing different page is rewritten', async (t) => {
  const p = setup(t, {
    tabs: [
      { id: 1, url: 'https://manual.test:8443/docs?q=1#other', status: 'complete' },
      { id: 2, url: 'https://manual.test:8443/docs?q=1#part', status: 'complete' },
      { id: 3, url: 'https://manual.test/docs?q=1#part', status: 'complete' },
    ],
  });
  const tab = await connectSourceURL('https://manual.test:8443/docs?q=1#part', {
    chrome: p.chrome,
  });
  assert.equal(tab.id, 2);
  assert.deepEqual(p.calls.queries, [{ url: 'https://manual.test/*' }]);
  assert.equal(p.calls.creates.length, 0);
  assert.equal(p.calls.scripts.length, 0);
});

test('a new source opens inactive and waits for complete loading without capturing', async (t) => {
  const p = setup(t);
  const pending = connectSourceURL('http://manual.test/docs', { chrome: p.chrome });
  await waitFor(() => p.updated.size === 1);
  assert.deepEqual(p.calls.creates, [{ url: 'http://manual.test/docs', active: false }]);
  p.update(50, { status: 'complete' });
  assert.equal((await pending).id, 50);
  assert.equal(p.calls.scripts.length, 0);
  assert.equal(p.calls.removed.length, 0);
});

test('same-origin login is returned untouched but cross-origin redirect requires explicit reconnection', async (t) => {
  const same = setup(t);
  const login = connectSourceURL('https://manual.test/docs', { chrome: same.chrome });
  await waitFor(() => same.updated.size === 1);
  same.update(50, { url: 'https://manual.test/login', status: 'complete' });
  assert.equal((await login).url, 'https://manual.test/login');
  assert.equal(same.calls.scripts.length, 0);
  const foreign = setup(t);
  const redirect = connectSourceURL('https://manual.test/docs', { chrome: foreign.chrome });
  await waitFor(() => foreign.updated.size === 1);
  foreign.update(50, { url: 'https://other.test/login', status: 'complete' });
  await assert.rejects(
    redirect,
    (error) => error.code === 'SOURCE_REDIRECTED' && /重新连接/.test(error.message),
  );
  assert.equal(foreign.calls.removed.length, 0);
});

for (const scenario of ['browser-error', 'closed', 'timeout'])
  test(`loading ${scenario} rejects and cleans up without deleting any user tab`, async (t) => {
    const p = setup(t);
    const pending = connectSourceURL('https://manual.test/docs', {
      chrome: p.chrome,
      timeoutMs: scenario === 'timeout' ? 10 : 1000,
    });
    const rejection = assert.rejects(
      pending,
      (error) =>
        error.code ===
        { 'browser-error': 'LOAD_FAILED', closed: 'TAB_CLOSED', timeout: 'LOAD_TIMEOUT' }[scenario],
    );
    await waitFor(() => p.updated.size === 1);
    if (scenario === 'browser-error')
      p.update(50, { url: 'chrome-error://chromewebdata/', status: 'complete' });
    if (scenario === 'closed') p.close(50);
    await rejection;
    assert.equal(p.calls.removed.length, 0);
  });

test('concurrent connections to one full URL create only one tab and share its completion', async (t) => {
  const p = setup(t);
  const a = connectSourceURL('https://manual.test/docs?q=1#part', { chrome: p.chrome });
  const b = connectSourceURL('https://manual.test/docs?q=1#part', { chrome: p.chrome });
  assert.equal(
    p.calls.permissions.length,
    2,
    'both gestures must synchronously request only the selected website',
  );
  await waitFor(() => p.updated.size === 1);
  p.update(50, { status: 'complete' });
  const result = await Promise.all([a, b]);
  assert.deepEqual(
    result.map((tab) => tab.id),
    [50, 50],
  );
  assert.equal(p.calls.creates.length, 1);
  assert.equal(p.calls.queries.length, 1);
});

test('asynchronous permission rejection cannot advance to browser tab operations', async (t) => {
  const p = setup(t, { permission: () => Promise.reject(new Error('permission dialog failed')) });
  await assert.rejects(
    connectSourceURL('https://manual.test/docs', { chrome: p.chrome }),
    (error) => error.code === 'PERMISSION_FAILED',
  );
  assert.equal(p.calls.queries.length, 0);
  assert.equal(p.calls.creates.length, 0);
});

test('a failed connection releases deduplication so the retained tab can be connected again', async (t) => {
  const p = setup(t);
  const first = connectSourceURL('https://manual.test/docs', { chrome: p.chrome, timeoutMs: 5 });
  await assert.rejects(first, (error) => error.code === 'LOAD_TIMEOUT');
  p.update(50, { status: 'complete' });
  const second = await connectSourceURL('https://manual.test/docs', { chrome: p.chrome });
  assert.equal(second.id, 50);
  assert.equal(p.calls.creates.length, 1);
  assert.equal(p.calls.removed.length, 0);
});

test('a failed tab create reports failure without injecting or deleting existing tabs', async (t) => {
  const p = setup(t, { tabs: [{ id: 1, url: 'https://manual.test/other', status: 'complete' }] });
  p.chrome.tabs.create = async () => {
    throw new Error('create failed');
  };
  await assert.rejects(
    connectSourceURL('https://manual.test/docs', { chrome: p.chrome }),
    (error) => error.code === 'LOAD_FAILED',
  );
  assert.equal(p.records.get(1).url, 'https://manual.test/other');
  assert.equal(p.calls.scripts.length, 0);
  assert.equal(p.calls.removed.length, 0);
});

test('a completed tab with an inaccessible current URL cannot reuse a stale authorized address', async (t) => {
  const p = setup(t);
  const pending = connectSourceURL('https://manual.test/docs', { chrome: p.chrome });
  const rejection = assert.rejects(pending, (error) => error.code === 'SOURCE_REDIRECTED');
  await waitFor(() => p.updated.size === 1);
  p.records.set(50, { id: 50, status: 'complete' });
  for (const callback of p.updated)
    callback(50, { status: 'complete' }, { id: 50, status: 'complete' });
  await rejection;
  assert.equal(p.calls.removed.length, 0);
});

test('wildcard hostnames are rejected before any website permission request', async (t) => {
  const p = setup(t);
  for (const url of [
    'https://*/',
    'https://*.example.com/',
    'https://%2A/',
    'https://%2A.example.com/',
  ]) {
    assert.throws(
      () => parseSourceURL(url),
      (error) => error.code === 'INVALID_URL',
    );
    await assert.rejects(
      connectSourceURL(url, { chrome: p.chrome }),
      (error) => error.code === 'INVALID_URL',
    );
  }
  assert.deepEqual(p.calls.permissions, []);
  assert.deepEqual(p.calls.queries, []);
  assert.deepEqual(p.calls.creates, []);
});

test('known exact manual and management paths override the view without guessing from URL substrings', () => {
  assert.equal(typeof resolveSourcePurpose, 'function');
  for (const [url, fallback, expected] of [
    ['https://manual.test/adocs.php', 'rotation', 'document'],
    [
      'https://manual.test:8443/cdocs.php?index=0&dataID=api-menu-item28#chapter',
      'rotation',
      'document',
    ],
    ['http://manual.test/framework.php#/mod_home/index', 'document', 'rotation'],
    ['https://manual.test/docs?next=/adocs.php', 'rotation', 'rotation'],
    ['https://manual.test/docs#/cdocs.php', 'rotation', 'rotation'],
    ['https://manual.test/my-adocs.php', 'rotation', 'rotation'],
    ['https://manual.test/adocs.php/extra', 'rotation', 'rotation'],
    ['https://manual.test/ADOCS.PHP', 'rotation', 'rotation'],
    ['https://manual.test/docs', 'document', 'document'],
    ['https://manual.test/login', 'rotation', 'rotation'],
    ['file:///adocs.php', 'rotation', 'rotation'],
    ['invalid', 'document', 'document'],
  ])
    assert.equal(resolveSourcePurpose(url, fallback), expected, url);
});

for (const route of ['adocs.php', 'cdocs.php'])
  test(`reconnecting ${route} reuses its open chapter without navigating it`, async (t) => {
    const current = `https://manual.test/${route}?index=7&dataID=api-menu-item58`;
    const p = setup(t, { tabs: [{ id: 7, url: current, status: 'complete' }] });
    // Fail directly if the connector tries to create a duplicate, without a load timeout.
    p.chrome.tabs.create = async () => {
      throw new Error('unexpected duplicate tab');
    };
    for (const entry of [
      `https://manual.test/${route}`,
      `https://manual.test/${route}?index=0&dataID=api-menu-item50`,
    ]) {
      const tab = await connectSourceURL(entry, { chrome: p.chrome });
      assert.equal(tab.id, 7);
      assert.equal(tab.url, current);
      assert.equal(p.records.get(7).url, current);
    }
    assert.equal(p.calls.scripts.length, 0);
  });

test('an exact chapter match takes priority over another chapter of the same manual', async (t) => {
  const entry = 'https://manual.test/adocs.php?index=0&dataID=api-menu-item50';
  const p = setup(t, {
    tabs: [
      {
        id: 1,
        url: 'https://manual.test/adocs.php?index=7&dataID=api-menu-item58',
        status: 'complete',
      },
      { id: 2, url: entry, status: 'complete' },
    ],
  });
  assert.equal((await connectSourceURL(entry, { chrome: p.chrome })).id, 2);
  assert.equal(p.calls.creates.length, 0);
});

test('different chapter connections share one in-flight manual tab', async (t) => {
  const p = setup(t);
  const first = connectSourceURL('https://manual.test/adocs.php?index=0&dataID=api-menu-item50', {
    chrome: p.chrome,
  });
  const second = connectSourceURL('https://manual.test/adocs.php?index=7&dataID=api-menu-item58', {
    chrome: p.chrome,
  });
  await waitFor(() => p.calls.creates.length > 0);
  await tick();
  for (const id of p.records.keys()) p.update(id, { status: 'complete' });
  const tabs = await Promise.all([first, second]);
  assert.equal(tabs[0].id, tabs[1].id);
  assert.equal(p.calls.creates.length, 1);
});

for (const other of [
  'https://manual.test/cdocs.php?index=7&dataID=api-menu-item58',
  'http://manual.test/adocs.php?index=7&dataID=api-menu-item58',
  'https://manual.test:8443/adocs.php?index=7&dataID=api-menu-item58',
  'https://other.test/adocs.php?index=7&dataID=api-menu-item58',
  'https://manual.test/adocs.php?index=7&dataID=api-menu-item58&lang=en',
  'https://manual.test/adocs.php?index=7&index=8&dataID=api-menu-item58',
  'https://manual.test/adocs.php?index=invalid&dataID=api-menu-item58',
  'https://manual.test/adocs.php?dataID=api-menu-item58',
  'https://manual.test/adocs.php#different-route',
  'https://manual.test/framework.php',
  'https://manual.test/docs?index=7&dataID=api-menu-item58',
])
  test(`manual reuse does not merge ${other}`, async (t) => {
    const p = setup(t, { tabs: [{ id: 7, url: other, status: 'complete' }] });
    const entry = 'https://manual.test/adocs.php?index=0&dataID=api-menu-item50';
    const pending = connectSourceURL(entry, { chrome: p.chrome });
    await waitFor(() => p.updated.size === 1);
    p.update(50, { status: 'complete' });
    assert.equal((await pending).id, 50);
    assert.equal(p.records.get(7).url, other);
  });

test('capacity blocks creating a new tab but permits finding an existing controlled manual', async (t) => {
  const entry = 'https://manual.test/adocs.php?index=0&dataID=api-menu-item50';
  const p = setup(t, {
    tabs: [
      { id: 1, url: entry, status: 'complete' },
      {
        id: 2,
        url: 'https://manual.test/adocs.php?index=7&dataID=api-menu-item58',
        status: 'complete',
      },
    ],
  });
  const options = { chrome: p.chrome, preferredTabIds: [2], canCreate: () => false, timeoutMs: 10 };
  assert.equal((await connectSourceURL(entry, options)).id, 2);
  await assert.rejects(
    connectSourceURL('https://manual.test/another', options),
    (error) => error.code === 'SOURCE_LIMIT',
  );
  assert.equal(p.calls.creates.length, 0);
});
