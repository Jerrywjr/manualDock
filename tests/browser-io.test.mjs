import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserIO } from '../extension/browser-io.js';
const profile = {
  schemaVersion: 1,
  id: 'p',
  revision: 1,
  adapterId: 'generic',
  entry: 'https://manual.test/docs/#a',
  origin: 'https://manual.test',
  pathPrefix: '/docs',
  hashMode: 'route',
  queryKeys: [],
  tocSelector: 'nav',
  contentSelector: 'main',
  navigation: 'links',
  samples: [],
};
function serializable(value) {
  if (value === undefined || typeof value === 'function')
    throw new Error('Value is unserializable');
  if (value && typeof value === 'object') for (const v of Object.values(value)) serializable(v);
}
test('browser IO directory discovery uses serializable arguments when no chapter is requested', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  globalThis.chrome = {
    tabs: { get: async () => ({ url: profile.entry, status: 'complete' }) },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        serializable(options.args);
        if (options.args[0] === 'discover')
          return [{ result: { items: [{ url: profile.entry, title: 'A' }], warnings: [] } }];
        return [{ result: { body: { auth: false, signature: 'A', nonEmpty: true }, proof: null } }];
      },
    },
  };
  const result = await createBrowserIO(1).discover(profile);
  assert.equal(result.items[0].title, 'A');
});

async function simulatedCapture(t, { fullDocument = false, alreadySelected = false } = {}) {
  const previous = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    opened = false,
    url = fullDocument ? 'https://manual.test/docs/a.html' : profile.entry;
  const selected = fullDocument
    ? 'https://manual.test/docs/b.html'
    : alreadySelected
      ? profile.entry
      : 'https://manual.test/docs/#b';
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    queueMicrotask(() => {
      now += ms;
      fn();
    });
    return 1;
  };
  const body = () => (fullDocument ? 'same body' : now >= 4000 ? 'new body' : 'old body');
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url, status: 'complete' }),
      update: async (_id, options) => {
        opened = true;
        url = options.url;
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        serializable(options.args);
        if (options.args.length === 1) {
          return [{ result: { status: 'ok', url, text: body(), warnings: [], diagnostics: {} } }];
        }
        return [
          {
            result: {
              documentId: fullDocument && opened ? 'new-document' : 'original-document',
              body: { auth: false, signature: body(), nonEmpty: true, loading: false },
              proof: { verified: alreadySelected || opened, kind: 'url' },
            },
          },
        ];
      },
    },
  };
  return createBrowserIO(1).capture({ key: 'url:' + selected, url: selected, title: 'B' }, profile);
}
test('hash route capture waits for replacement body even when URL and old body are already stable', async (t) => {
  const page = await simulatedCapture(t);
  assert.equal(page.text, 'new body');
  assert.equal(page.navigationProof.verified, true);
});
test('a new document may legitimately have identical text to the previous page', async (t) => {
  const page = await simulatedCapture(t, { fullDocument: true });
  assert.equal(page.text, 'same body');
  assert.equal(page.navigationProof.verified, true);
});
test('the already selected current chapter does not require an artificial body change', async (t) => {
  const page = await simulatedCapture(t, { alreadySelected: true });
  assert.equal(page.text, 'old body');
  assert.equal(page.navigationProof.verified, true);
});

for (const mode of ['frame-link', 'reloading-click'])
  test(
    'browser IO handles ' + mode + ' navigation without losing its scope or document proof',
    async (t) => {
      const previous = {
        chrome: globalThis.chrome,
        setTimeout: globalThis.setTimeout,
        now: Date.now,
      };
      t.after(() => {
        globalThis.chrome = previous.chrome;
        globalThis.setTimeout = previous.setTimeout;
        Date.now = previous.now;
      });
      let now = 0,
        opened = false;
      Date.now = () => now;
      globalThis.setTimeout = (fn, ms) => {
        queueMicrotask(() => {
          now += ms;
          fn();
        });
        return 1;
      };
      const frame = mode === 'frame-link',
        topURL = 'https://manual.test/docs/wrapper',
        chapter = {
          url: 'https://manual.test/docs/b',
          title: 'B',
          ...(frame ? {} : { locator: { kind: 'generic-toc', path: ['B'] } }),
        },
        p = { ...profile, entry: topURL, ...(frame ? { frameSelector: '#manual-frame' } : {}) };
      globalThis.chrome = {
        tabs: {
          get: async () => ({ url: topURL, status: 'complete' }),
          update: async () => {
            throw new Error('top-level navigation destroys the configured frame');
          },
        },
        scripting: {
          executeScript: async (options) => {
            if (options.files) return [];
            if (options.args?.length === 0) return [{ result: '' }];
            serializable(options.args);
            if (options.args[0] === 'open') {
              opened = true;
              throw new Error('Execution context was destroyed');
            }
            if (options.args.length === 3) {
              opened = true;
              return [{ result: { navigated: true } }];
            }
            if (options.args.length === 1)
              return [
                {
                  result: {
                    status: 'ok',
                    url: topURL,
                    text: 'new body',
                    warnings: [],
                    diagnostics: {},
                  },
                },
              ];
            return [
              {
                result: {
                  documentId: opened ? 'new-document' : 'old-document',
                  documentURL: opened ? chapter.url : 'https://manual.test/docs/a',
                  body: {
                    auth: false,
                    signature: opened ? 'new body' : 'old body',
                    nonEmpty: true,
                    loading: false,
                  },
                  proof: { verified: opened, kind: frame ? 'frame-url' : 'generic-toc' },
                },
              },
            ];
          },
        },
      };
      const result = await createBrowserIO(1).capture(chapter, p);
      assert.equal(result.status, 'ok');
      assert.equal(result.navigationProof.verified, true);
      if (frame) assert.equal(result.url, chapter.url);
    },
  );

const pictureA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const pictureB = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
async function verifyImageSamples(t, pages) {
  const previous = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    url = profile.entry;
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    queueMicrotask(() => {
      now += ms;
      fn();
    });
    return 1;
  };
  const samples = pages.map((_, index) => ({
    key: 'sample:' + index,
    url: 'https://manual.test/docs/' + index,
    title: String(index),
  }));
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url, status: 'complete' }),
      update: async (_id, options) => {
        url = options.url;
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        serializable(options.args);
        if (options.args.length === 1)
          return [
            { result: { status: 'ok', url, ...pages[samples.findIndex((c) => c.url === url)] } },
          ];
        return [
          {
            result: {
              documentId: url,
              body: { auth: false, signature: url, nonEmpty: true, loading: false },
              proof: { verified: true, kind: 'url' },
            },
          },
        ];
      },
    },
  };
  return createBrowserIO(1).verifySamples({ ...profile, samples });
}
for (const entry of [
  {
    name: 'different embedded images can verify image-only chapters',
    text: '',
    images: [pictureA, pictureB],
    pass: true,
  },
  {
    name: 'different embedded images distinguish otherwise identical text',
    text: 'shared',
    images: [pictureA, pictureB],
    pass: true,
  },
  {
    name: 'the same image and text cannot verify merely different wrapper HTML',
    text: 'shared',
    images: [pictureA, pictureA],
    pass: false,
  },
  {
    name: 'image-only chapters without embedded images remain unverified',
    text: '',
    images: ['https://manual.test/a.png', 'https://manual.test/b.png'],
    pass: false,
  },
])
  test(entry.name, async (t) => {
    const pages = entry.images.map((src, index) => ({
      text: entry.text,
      html: '<div class="wrapper' + index + '"><img alt="' + index + '" src="' + src + '"></div>',
      diagnostics: { images: { embedded: src.startsWith('data:') ? 1 : 0 } },
    }));
    if (entry.pass) assert.equal((await verifyImageSamples(t, pages)).verified, true);
    else await assert.rejects(verifyImageSamples(t, pages), /正文相同|图片|切换/);
  });

test('recovery reloads only the bound manual tab and waits until its document is ready', async (t) => {
  const previous = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    navigated = false,
    checks = 0;
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    queueMicrotask(() => {
      now += ms;
      fn();
    });
    return 1;
  };
  const navigations = [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({
        url: profile.entry,
        status: !navigated || ++checks > 2 ? 'complete' : 'loading',
      }),
      update: async (id, options) => {
        navigated = true;
        navigations.push({ id, ...options });
      },
    },
    scripting: {
      executeScript: async (options) =>
        options.files
          ? []
          : options.args?.length === 0
            ? [{ result: '' }]
            : [{ result: { body: { auth: false } } }],
    },
  };
  assert.deepEqual(await createBrowserIO(12).recover(profile), { status: 'ok' });
  assert.deepEqual(navigations, [{ id: 12, url: profile.entry }]);
  assert.ok(checks > 2);
});
for (const source of [
  'https://another.test/docs/',
  'https://manual.test/settings',
  'chrome-error://chromewebdata/',
])
  test('recovery refuses an unrelated or unprovable source: ' + source, async (t) => {
    const previous = globalThis.chrome;
    t.after(() => {
      globalThis.chrome = previous;
    });
    let writes = 0;
    globalThis.chrome = {
      tabs: {
        get: async () => ({ url: source, status: 'complete' }),
        update: async () => {
          writes++;
        },
      },
      scripting: {
        executeScript: async () => {
          throw new Error('must not inspect an unrelated tab');
        },
      },
    };
    await assert.rejects(createBrowserIO(1).recover(profile), /来源|范围|无法确认|网站/);
    assert.equal(writes, 0);
  });
test('recovery can restore a browser error page when its pending navigation still proves the manual scope', async (t) => {
  const previous = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    url = 'chrome-error://chromewebdata/';
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    queueMicrotask(() => {
      now += ms;
      fn();
    });
    return 1;
  };
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url, pendingUrl: profile.entry, status: 'complete' }),
      update: async (_id, options) => {
        url = options.url;
      },
    },
    scripting: {
      executeScript: async (options) =>
        options.files
          ? []
          : options.args?.length === 0
            ? [{ result: '' }]
            : [{ result: { body: { auth: false } } }],
    },
  };
  assert.equal((await createBrowserIO(1).recover(profile)).status, 'ok');
  assert.equal(url, profile.entry);
});
test('authentication waiting never reloads or submits the login page', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  let writes = 0;
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: 'https://manual.test/login.php', status: 'complete' }),
      update: async () => {
        writes++;
      },
    },
    scripting: {
      executeScript: async () => {
        throw new Error('login form must remain untouched');
      },
    },
  };
  assert.equal((await createBrowserIO(1).recover(profile)).status, 'auth');
  assert.equal(writes, 0);
});
test('sample verification preserves authentication failures for the automatic scheduler', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  globalThis.chrome = {
    tabs: { get: async () => ({ url: 'https://manual.test/login.php', status: 'complete' }) },
  };
  await assert.rejects(
    createBrowserIO(1).verifySamples({
      ...profile,
      samples: [
        { key: 'a', url: profile.entry },
        { key: 'b', url: 'https://manual.test/docs/#b' },
      ],
    }),
    (error) => error.code === 'AUTH_REQUIRED',
  );
});

test('cancelling verification before it starts never opens a sample', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  let reads = 0;
  globalThis.chrome = {
    tabs: {
      get: async () => {
        reads++;
        throw new Error('must not inspect');
      },
    },
  };
  await assert.rejects(
    createBrowserIO(1).verifySamples(
      {
        ...profile,
        samples: [
          { key: 'a', url: profile.entry },
          { key: 'b', url: 'https://manual.test/docs/#b' },
        ],
      },
      { shouldContinue: () => false },
    ),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(reads, 0);
});
test('cancelling during the first sample prevents navigation to the second sample', async (t) => {
  const previous = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    url = profile.entry,
    allowed = true;
  const opened = [];
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    queueMicrotask(() => {
      now += ms;
      fn();
    });
    return 1;
  };
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url, status: 'complete' }),
      update: async (_id, options) => {
        url = options.url;
        opened.push(url);
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        if (options.args.length === 1) {
          allowed = false;
          return [{ result: { status: 'ok', url, text: 'one sample' } }];
        }
        return [
          {
            result: {
              documentId: url,
              body: { auth: false, signature: url, nonEmpty: true, loading: false },
              proof: { verified: true, kind: 'url' },
            },
          },
        ];
      },
    },
  };
  const samples = [
    { key: 'a', url: profile.entry },
    { key: 'b', url: 'https://manual.test/docs/#b' },
  ];
  await assert.rejects(
    createBrowserIO(1).verifySamples({ ...profile, samples }, { shouldContinue: () => allowed }),
    (error) => error.code === 'CANCELLED',
  );
  assert.deepEqual(opened, [profile.entry]);
});

test('quick discovery reaches the page adapter without losing scope checks', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  let url = profile.entry;
  globalThis.chrome = {
    tabs: { get: async () => ({ url, status: 'complete' }) },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        serializable(options.args);
        if (options.args[0] === 'discover')
          return [
            {
              result: {
                items: options.args[1].expand === false ? [{ title: 'loaded chapter' }] : [],
                diagnostics: { pendingBranches: 1 },
              },
            },
          ];
        return [{ result: { body: { auth: false } } }];
      },
    },
  };
  assert.equal(
    (await createBrowserIO(1).discover(profile, { expand: false })).items[0]?.title,
    'loaded chapter',
  );
  url = 'https://other.test/docs/';
  await assert.rejects(createBrowserIO(1).discover(profile, { expand: false }), /网站/);
});

test('current chapter detection forwards only an authenticated bound document', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  let url = profile.entry,
    auth = false;
  globalThis.chrome = {
    tabs: { get: async () => ({ url, status: 'complete' }) },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        serializable(options.args);
        if (options.args[0] === 'current')
          return [{ result: { status: 'ok', chapter: { url, title: 'Current' } } }];
        return [{ result: { body: { auth } } }];
      },
    },
  };
  const io = createBrowserIO(1);
  assert.equal(typeof io.current, 'function');
  assert.equal((await io.current(profile)).chapter.title, 'Current');
  auth = true;
  assert.equal((await io.current(profile)).status, 'auth');
  auth = false;
  url = 'https://other.test/';
  await assert.rejects(io.current(profile), /网站|范围/);
});

test('browser install explicitly reports a legacy picker block even when file injection itself succeeds', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { readFile } = await import('node:fs/promises');
  const adapterSource = await readFile(
    new URL('../extension/manual-adapters.js', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(
    '<nav><a href="a">A</a><a href="b">B</a></nav><main><button>Page action</button></main>',
    { url: profile.entry, runScripts: 'outside-only' },
  );
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () {
    return [{}];
  };
  w.eval(adapterSource);
  const { dispose: _dispose, ...legacyMethods } = w.SecurityManualAdapters;
  const legacy = Object.freeze(legacyMethods);
  w.SecurityManualAdapters = legacy;
  const picking = legacy.pick({ kind: 'content', profile });
  picking.catch(() => {});
  const previous = globalThis.chrome;
  const operations = [];
  let navigations = 0;
  t.after(() => {
    globalThis.chrome = previous;
    w.close();
  });
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: profile.entry, status: 'complete' }),
      update: async () => {
        navigations++;
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) {
          w.eval(adapterSource);
          return [{ result: null }];
        }
        operations.push(options.args || []);
        const value = w.eval('(' + options.func.toString() + ')')(...(options.args || []));
        return [{ result: await value }];
      },
    },
  };
  const io = createBrowserIO(1);
  for (const operation of [
    () => io.detect(),
    () => io.discover(profile),
    () => io.current(profile),
    () => io.pick('content', profile),
    () => io.capture({ url: profile.entry, title: 'A' }, profile),
  ])
    await assert.rejects(operation(), /旧版.*点选.*Esc.*刷新/);
  assert.equal(
    operations.some((args) => ['detect', 'discover', 'current', 'pick', 'open'].includes(args[0])),
    false,
  );
  assert.equal(navigations, 0);
  assert.equal(w.SecurityManualAdapters, legacy);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await assert.rejects(picking, /取消/);
  const detected = await io.detect();
  assert.equal(detected.profile.contentSelector, 'main');
  assert.equal(w.SecurityManualAdapterInstallError, '');
});

for (const method of ['capture', 'discover', 'current'])
  test(
    method + ' classifies a proven browser error as recoverable before origin checking',
    async (t) => {
      const previous = globalThis.chrome;
      t.after(() => {
        globalThis.chrome = previous;
      });
      globalThis.chrome = {
        tabs: {
          get: async () => ({ url: 'chrome-error://chromewebdata/', pendingUrl: profile.entry }),
        },
      };
      const io = createBrowserIO(1);
      const invoke = () =>
        method === 'capture' ? io.capture({ url: profile.entry }, profile) : io[method](profile);
      await assert.rejects(invoke(), (e) => e.code === 'NETWORK_ERROR');
      globalThis.chrome.tabs.get = async () => ({
        url: 'chrome-error://chromewebdata/',
        pendingUrl: 'https://other.test/',
      });
      await assert.rejects(invoke(), /无法确认/);
    },
  );

async function bindingPreparation(
  t,
  {
    mismatch = false,
    ambiguous = false,
    wrongAdapter = false,
    sameBody = false,
    multiRoot = false,
    singleExt = false,
    extraChapters = false,
    loseAfterSamples = false,
  } = {},
) {
  const prior = { chrome: globalThis.chrome, timer: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = prior.chrome;
    globalThis.setTimeout = prior.timer;
    Date.now = prior.now;
  });
  let now = 0,
    url = profile.entry;
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms) => {
    queueMicrotask(() => {
      now += ms;
      callback();
    });
    return 1;
  };
  const original = {
    ...profile,
    tocSelector: multiRoot || singleExt ? 'nav' : '#ext-gen-old',
    adapterId: singleExt ? 'sangfor' : profile.adapterId,
    contentSelector: 'main',
  };
  const chapters = Array.from({ length: 12 }, (_, i) => ({
    url: 'https://manual.test/docs/chapter' + i,
    title: 'Chapter ' + i,
  }));
  const navigations = [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url, status: 'complete' }),
      update: async (_, options) => {
        navigations.push(options.url);
        url = options.url;
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        const [name, value] = options.args;
        if (name === 'bindings')
          return [
            {
              result:
                value.profile.tocSelector === '#ext-gen-old'
                  ? {
                      status: 'error',
                      issues: [{ region: 'toc', count: ambiguous ? 2 : 0 }],
                      error: '目录旧定位失效，请重新校准',
                    }
                  : {
                      status: 'ok',
                      profile: value.profile,
                      directoryRoots: multiRoot ? 5 : singleExt ? 1 : 0,
                    },
            },
          ];
        if (name === 'current')
          return [
            {
              result:
                value.profile.tocSelector === '#ext-gen-old'
                  ? { status: 'error', error: '旧目录失效，请重新校准' }
                  : { status: 'ok', chapter: chapters[0] },
            },
          ];
        if (name === 'detect')
          return [
            {
              result: {
                profile: {
                  ...profile,
                  adapterId: wrongAdapter ? 'sangfor' : original.adapterId,
                  tocSelector: 'nav',
                },
              },
            },
          ];
        if (name === 'discover')
          return [
            {
              result: {
                items:
                  mismatch || (loseAfterSamples && navigations.length >= 2)
                    ? chapters.slice(0, 11)
                    : extraChapters
                      ? [
                          ...chapters,
                          { url: 'https://manual.test/docs/unrelated', title: 'Unrelated manual' },
                        ]
                      : chapters,
                diagnostics: {},
              },
            },
          ];
        if (options.args.length === 1)
          return [
            {
              result: {
                status: 'ok',
                url,
                text: sameBody ? 'same body' : url,
                warnings: [],
                diagnostics: {},
              },
            },
          ];
        return [
          {
            result: {
              documentId: url,
              body: { auth: false, signature: url, nonEmpty: true, loading: false },
              proof: { verified: true },
            },
          },
        ];
      },
    },
  };
  return {
    original,
    chapters,
    navigations,
    run: () => createBrowserIO(1).prepare(original, chapters),
    identify: () => createBrowserIO(1).boundCurrent(original),
  };
}

test('binding recovery proves every old chapter and two distinct bodies before proposing an update', async (t) => {
  const p = await bindingPreparation(t);
  const result = await p.run();
  assert.equal(result.changed, true);
  assert.equal(result.verified, true);
  assert.equal(result.profile.tocSelector, 'nav');
  assert.equal(p.original.tocSelector, '#ext-gen-old');
  assert.deepEqual(
    p.navigations,
    p.chapters.slice(0, 2).map((c) => c.url),
  );
  assert.equal(result.profile.entry, p.original.entry);
  assert.equal(result.profile.id, p.original.id);
});
for (const condition of ['mismatch', 'ambiguous', 'wrongAdapter'])
  test('binding recovery rejects ' + condition + ' without navigating samples', async (t) => {
    const p = await bindingPreparation(t, { [condition]: true });
    await assert.rejects(p.run(), /重新校准/);
    assert.deepEqual(p.navigations, []);
  });
test('binding recovery rejects identical sample bodies without changing the original rule', async (t) => {
  const p = await bindingPreparation(t, { sameBody: true });
  await assert.rejects(p.run(), /两个示例正文相同/);
  assert.equal(p.original.tocSelector, '#ext-gen-old');
});

test('restored source can identify an existing chapter through missing bindings without navigating', async (t) => {
  const p = await bindingPreparation(t);
  const result = await p.identify();
  assert.equal(result.status, 'ok');
  assert.equal(result.chapter.title, p.chapters[0].title);
  assert.deepEqual(p.navigations, []);
  assert.equal(p.original.tocSelector, '#ext-gen-old');
});
for (const condition of ['ambiguous', 'wrongAdapter'])
  test(
    'restored source refuses ' + condition + ' during read-only identity checking',
    async (t) => {
      const p = await bindingPreparation(t, { [condition]: true });
      await assert.rejects(p.identify(), /重新校准/);
      assert.deepEqual(p.navigations, []);
    },
  );

test('unchanged multi-root rules still prove the old queue and sample both ends before continuing', async (t) => {
  const p = await bindingPreparation(t, { multiRoot: true });
  const result = await p.run();
  assert.equal(result.verified, true);
  assert.equal(result.profile.tocSelector, p.original.tocSelector);
  assert.equal(result.profile.id, p.original.id);
  assert.deepEqual(p.navigations, [p.chapters[0].url, p.chapters.at(-1).url]);
});
test('unchanged multi-root rules cannot bypass old queue mismatch with a saved signature', async (t) => {
  const p = await bindingPreparation(t, { multiRoot: true, mismatch: true });
  await assert.rejects(p.run(), /重新校准/);
  assert.deepEqual(p.navigations, []);
});

test('unchanged single-root Ext rules cannot reuse validation for an out-of-scope old queue', async (t) => {
  const p = await bindingPreparation(t, { singleExt: true, mismatch: true });
  await assert.rejects(p.run(), /重新校准/);
  assert.deepEqual(p.navigations, []);
});
test('automatic directory rebinding cannot expand into chapters outside the saved queue', async (t) => {
  const p = await bindingPreparation(t, { extraChapters: true });
  await assert.rejects(p.run(), /重新校准/);
  assert.deepEqual(p.navigations, []);
});
test('directory rebinding rechecks the full queue after sample navigation recreates roots', async (t) => {
  const p = await bindingPreparation(t, { multiRoot: true, loseAfterSamples: true });
  await assert.rejects(p.run(), /重新校准/);
  assert.equal(p.navigations.length, 2);
});

function proofTransitionCapture(t, observation) {
  const prior = { chrome: globalThis.chrome, timer: globalThis.setTimeout, now: Date.now };
  t.after(() => {
    globalThis.chrome = prior.chrome;
    globalThis.setTimeout = prior.timer;
    Date.now = prior.now;
  });
  let now = 0,
    opened = false,
    captures = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms) => {
    queueMicrotask(() => {
      now += ms;
      callback();
    });
    return 1;
  };
  const chapter = {
    key: 'toc:chapter-b',
    url: profile.entry,
    title: 'B',
    locator: { kind: 'generic-toc', path: ['B'] },
  };
  globalThis.chrome = {
    tabs: {
      get: async () => ({
        url: profile.entry,
        status: (opened && observation(now).tabStatus) || 'complete',
      }),
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        if (options.args?.[0] === 'open') {
          opened = true;
          return [{ result: { clicked: true } }];
        }
        if (options.func?.toString().includes('.prepareContent('))
          return [{ result: { status: 'ok', clicked: 0 } }];
        if (options.args?.length === 1) {
          captures++;
          return [{ result: { status: 'ok', text: 'B body', warnings: [], diagnostics: {} } }];
        }
        const observed = opened ? observation(now) : {};
        if (observed.interrupted) throw new Error('Execution context was destroyed');
        return [
          {
            result: {
              documentId: observed.documentId || (opened ? 'after-document' : 'before-document'),
              body: {
                auth: false,
                nonEmpty: true,
                loading: false,
                signature: opened ? 'B body' : 'A body',
                ...observed.body,
              },
              proof: observed.proof || { verified: true, kind: 'generic-toc' },
            },
          },
        ];
      },
    },
  };
  return {
    run: () => createBrowserIO(1).capture(chapter, profile),
    now: () => now,
    captures: () => captures,
    chapter,
  };
}
const invalidDirectoryReason = '目录定位匹配多个普通区域，请重新校准';
const invalidDirectoryFault = {
  name: 'Error',
  message: invalidDirectoryReason,
  stack: 'Error: directory failure\n    at directoryRoots (tree.js:107)',
};

for (const proof of [
  { verified: false, reason: invalidDirectoryReason, fault: invalidDirectoryFault },
  { verified: false, reason: invalidDirectoryReason },
  { verified: false, reason: '页面定位规则失效或不唯一：目录选择器 nav 匹配 2 个元素，请重新校准' },
  { verified: false, fault: invalidDirectoryFault },
  {
    verified: false,
    reason: 'The configured directory overlaps the article',
    errorCode: 'DIRECTORY_INVALID',
  },
])
  test(
    'persistent invalid directory proof stops before the loading timeout and preserves its cause: ' +
      (proof.errorCode ||
        (proof.fault ? (proof.reason ? 'reason and fault' : 'fault only') : proof.reason)),
    async (t) => {
      const p = proofTransitionCapture(t, () => ({ proof }));
      await assert.rejects(p.run(), (error) => {
        assert.equal(error.message, proof.reason || proof.fault?.message);
        assert.equal(error.stage, 'verify-directory');
        assert.equal(error.code, 'DIRECTORY_INVALID');
        assert.equal(error.chapterKey, p.chapter.key);
        assert.deepEqual(error.fault, proof.fault);
        return true;
      });
      assert.ok(
        p.now() >= 1200 && p.now() < 5000,
        'a structural error needs a bounded stability check',
      );
      assert.equal(p.captures(), 0, 'invalid directory proof must never extract the body');
    },
  );

for (const reason of [
  '目录定位没有匹配区域，请重新校准',
  '页面定位规则失效或不唯一：目录选择器 nav 匹配 0 个元素，请重新校准',
  'locator-not-found',
  'selected-path-mismatch',
])
  test(
    'temporary chapter replacement remains retryable while proof reports ' + reason,
    async (t) => {
      const p = proofTransitionCapture(t, (now) =>
        now < 4000
          ? {
              proof: { verified: false, reason, fault: { name: 'Error', message: reason } },
            }
          : {},
      );
      const page = await p.run();
      assert.equal(page.status, 'ok');
      assert.ok(p.now() >= 4000 && p.now() < 6000);
      assert.equal(p.captures(), 1);
    },
  );

for (const transition of ['proof', 'body', 'document', 'loading', 'context', 'tab', 'body-fault'])
  test(
    'directory error stability resets when chapter replacement changes ' + transition,
    async (t) => {
      const p = proofTransitionCapture(t, (now) => {
        if (now >= 2500) return {};
        const value = {
          proof: { verified: false, reason: invalidDirectoryReason, fault: invalidDirectoryFault },
        };
        if (now >= 900 && now < 1700) {
          if (transition === 'proof')
            value.proof = { verified: false, reason: 'selected-path-mismatch' };
          if (transition === 'body') value.body = { signature: 'intermediate body' };
          if (transition === 'document') value.documentId = 'intermediate-document';
          if (transition === 'loading') value.body = { loading: true };
          if (transition === 'context') value.interrupted = true;
          if (transition === 'tab') value.tabStatus = 'loading';
          if (transition === 'body-fault')
            value.body = { fault: { name: 'Error', message: 'Body temporarily unavailable' } };
        }
        return value;
      });
      const page = await p.run();
      assert.equal(page.status, 'ok');
      assert.ok(p.now() >= 2500 && p.now() < 5000);
    },
  );

test('a persistently missing directory retains the existing navigation timeout', async (t) => {
  const p = proofTransitionCapture(t, () => ({
    proof: {
      verified: false,
      reason: '目录定位没有匹配区域，请重新校准',
      fault: { name: 'Error', message: '目录定位没有匹配区域，请重新校准' },
    },
  }));
  await assert.rejects(p.run(), (error) => {
    assert.equal(error.code, 'LOAD_TIMEOUT');
    assert.match(error.message, /45秒.*目录选中未确认/);
    return true;
  });
  assert.ok(p.now() >= 45000 && p.now() < 46000);
  assert.equal(p.captures(), 0);
});

test('a body fault cannot be mistaken for an invalid directory proof', async (t) => {
  const p = proofTransitionCapture(t, (now) =>
    now < 4000
      ? {
          proof: { verified: false, reason: 'selected-path-mismatch' },
          body: { fault: invalidDirectoryFault },
        }
      : {},
  );
  const page = await p.run();
  assert.equal(page.status, 'ok');
  assert.ok(p.now() >= 4000 && p.now() < 6000);
});
