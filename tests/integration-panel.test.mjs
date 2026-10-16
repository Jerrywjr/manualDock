import test from 'node:test';
import { renderLibrary, libraryPageSize } from '../extension/library-view.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as profiles from '../extension/profiles.js';
import * as recovery from '../extension/recovery.js';
import { AutoRetryClock } from '../extension/auto-retry.js';
import { SourceSession } from '../extension/session.js';
import { createRotationController } from '../extension/rotation-controller.js';
import { createTask, ImportEngine } from '../extension/engine.js';
import { buildExports, contentHash, hasMissingExamples } from '../extension/core.js';
import { parseSpecification } from '../extension/openapi.js';
import * as bindCheck from '../extension/bind-check.js';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import * as realStore from '../extension/task-store.js';
const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8')).replace(
  /^import[\s\S]*?from ['"][^'"]+['"];?/gm,
  '',
);
const flush = () => new Promise((r) => setImmediate(r));
const seed = () =>
  profiles.validateProfile({
    schemaVersion: 1,
    id: 'profile',
    revision: 1,
    name: 'IPS',
    adapterId: 'generic',
    entry: 'https://manual.test/docs/index',
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    hashMode: 'route',
    queryKeys: [],
    tocSelector: 'nav',
    contentSelector: 'main',
    navigation: 'links',
    samples: [],
  });
async function setup(
  t,
  {
    holdTab = false,
    workspace = false,
    realRotation = false,
    savedProfiles = [],
    savedTasks = [],
    currentURL = null,
    savedSettings = [],
  } = {},
) {
  const dom = new JSDOM(html, {
      url: 'https://extension.test/panel.html?tab=1',
      runScripts: 'outside-only',
    }),
    w = dom.window;
  t.after(() => w.close());
  const settings = new Map(savedSettings);
  let releaseTab;
  const gate = new Promise((r) => (releaseTab = r)),
    disk = new Map(savedTasks.map((task) => [task.taskId, structuredClone(task)])),
    held = new Set();
  const state = {
    captured: [],
    verified: [],
    rotation: { running: false, count: 0, message: '未开始' },
    profile: currentURL ? { ...seed(), id: 'detected-profile', entry: currentURL } : seed(),
    detected: 0,
    picked: null,
    previewPage: { status: 'ok', text: 'preview' },
    verificationPreviews: null,
    detectionWarnings: [],
    discoveryWarnings: [],
    discoveredChapters: null,
  };
  const chapters = ['A', 'C'].map((title) => ({
    key: 'url:https://manual.test/docs/' + title,
    url: 'https://manual.test/docs/' + title,
    title,
  }));
  const clone = (v) => structuredClone(v);
  const io = {
    recover: async () => {
      state.recovered = (state.recovered || 0) + 1;
    },
    tab: async () => {
      if (holdTab) await gate;
      return { id: 1, url: state.profile.entry, status: 'complete' };
    },
    install: async () => {
      if (state.installGate) await state.installGate;
    },
    detect: async () => {
      state.detected++;
      return { profile: clone(state.profile), warnings: clone(state.detectionWarnings) };
    },
    discover: async () => {
      if (state.discoverGate) await state.discoverGate;
      return {
        items: clone(state.discoveredChapters ?? chapters),
        warnings: clone(state.discoveryWarnings),
        diagnostics: {},
      };
    },
    pick: async () => state.picked,
    capture: async (c, p) => {
      if (state.captureError) throw new Error(state.captureError);
      state.captured.push(clone(p));
      return {
        status: 'ok',
        url: c.url,
        text: 'body ' + c.title,
        navigationProof: { verified: true },
        warnings: [],
        diagnostics: {},
      };
    },
    verifySamples: async (p) => {
      if (state.verifyError) throw new Error(state.verifyError);
      state.verified.push(clone(p));
      return {
        verified: true,
        previews:
          state.verificationPreviews ||
          p.samples.map((c) => ({ title: c.title, text: 'body ' + c.title })),
      };
    },
  };
  function serializable(value) {
    if (value === undefined) throw new Error('Value is unserializable');
    if (value && typeof value === 'object') Object.values(value).forEach(serializable);
  }
  Object.assign(w, profiles, recovery, bindCheck, {
    subscribeTasks: (listener) => {
      state.notifyTasks = listener;
      return () => {};
    },
    setupBatch: (options) => {
      state.batchOptions = options;
      return workspace
        ? {
            publish() {},
            getSession: (id) => state.sessions?.get(id),
            removeSource: (id) => {
              const session = state.sessions?.get(id);
              if (!session) return false;
              state.sessions.delete(id);
              (state.removedSources ||= []).push(id);
              options.onRemoved(session);
              return true;
            },
          }
        : null;
    },
    setupSourceControls: () => ({ refresh() {}, dispose() {} }),
    createRemoteSession: () => {
      throw new Error('panel harness supplies source sessions explicitly');
    },
    listBackgroundSources: async () => [],
    createRemoteRotationController: (options) => {
      if (!realRotation) return { dispose() {} };
      const controller = createRotationController({
        ...options,
        chrome: w.chrome,
        locks: w.navigator.locks,
        timers: w,
      });
      state.controller = controller;
      t.after(() => controller.dispose());
      return controller;
    },
    AutoRetryClock,
    createTask,
    ImportEngine,
    buildExports,
    contentHash,
    hasMissingExamples,
    renderLibrary,
    libraryPageSize,
    parseSpecification,
    createBrowserIO: () => io,
    Blob,
    loadProfiles: async () => clone(savedProfiles),
    saveProfile: async (p) => {
      state.savedProfile = clone(p);
      const i = savedProfiles.findIndex((x) => x.id === p.id);
      if (i >= 0) savedProfiles[i] = clone(p);
      else savedProfiles.push(clone(p));
    },
    loadTask: async (id) => (disk.has(id) ? clone(disk.get(id)) : null),
    listTasks: async () => [...disk.values()],
    saveTask: async (task) => disk.set(task.taskId, clone(task)),
    saveWholeTask: async (task) => disk.set(task.taskId, clone(task)),
    setSetting: async (key, value) => settings.set(key, clone(value)),
    getSetting: async (key) => settings.get(key) || null,
    listSettings: async () => [...settings.keys()],
    deleteSetting: async (key) => {
      settings.delete(key);
    },
    deleteTask: async (id) => {
      disk.delete(id);
    },
    chrome: {
      tabs: { get: io.tab, getCurrent: async () => ({ id: 2 }), update: async () => {} },
      scripting: {
        executeScript: async (options) => {
          if (options.files) return [];
          if (options.args) serializable(options.args);
          if (typeof options.args?.[0] === 'string') {
            const action = options.args[0];
            if (action === 'start') {
              state.rotation = {
                running: true,
                count: 0,
                message: '运行中',
              };
            }
            if (action === 'prepare') {
              if (options.args[3]) {
                state.trialPreparations = (state.trialPreparations || 0) + 1;
                state.trialHadLock = held.has('source-tab:' + options.target.tabId);
                state.rotation = { running: true, count: 0, message: '试运行准备就绪' };
              }
              return [{ result: { running: true, intervalMs: 60000 } }];
            }
            if (action === 'execute') {
              state.rotation = {
                running: true,
                clicked: true,
                count: options.args[3].count + 1,
                message: '已点击',
              };
            }
            if (action === 'stopManaged') {
              await state.onManagedStop?.();
              state.rotation = { ...state.rotation, running: false, message: '停止' };
              return [{ result: { ...state.rotation } }];
            }
            if (action === 'stop') {
              await state.onRotationStop?.();
              state.rotation = { ...state.rotation, running: false, message: '停止' };
            }
            return [{ result: { ...state.rotation } }];
          }
          if (options.args) return [{ result: state.previewPage }];
          return [{ result: { running: state.rotation.running } }];
        },
      },
    },
  });
  if (workspace) w.chrome.runtime = { onMessage: { addListener() {}, removeListener() {} } };
  w.navigator.locks = {
    request: async (name, _options, callback) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.setInterval = () => 0;
  w.eval(
    source +
      '\n;globalThis.TestPanel={setController:value=>{rotationController=value;normalRotationTabs.add(tabId);},getSelected:()=>selectedSession,getRotationSession:()=>rotationSession,locked,startSelected,fetchSpec,selectSession,getIO:()=>io,setSession:value=>{selectedSession=value;},render,error,detect,checkBind,openTask,retryAutomatically,pauseImport,retryClock,previewCurrent,importSpec,scan,run,sample,verifyAndSave,rotationAction,rotationTrial,rotationCall,getTask:()=>task,getProfile:()=>profile,setRotation:value=>{rotationConfig=value;rotationVerified=false;showRotationTargets();},getRotationVerified:()=>rotationVerified};',
  );
  return {
    w,
    document: w.document,
    state,
    disk,
    held,
    api: w.TestPanel,
    releaseTab,
    settle: async () => {
      for (let i = 0; i < 15; i++) await flush();
    },
  };
}
test('panel web actions remain gated until initialization finishes', async (t) => {
  const p = await setup(t, { holdTab: true });
  assert.equal(p.document.getElementById('start').disabled, true);
  assert.equal(p.document.getElementById('spec-file').disabled, false);
  p.releaseTab();
  await p.settle();
  assert.equal(p.document.getElementById('start').disabled, false);
});
test('a missing article selector exposes calibration while retaining verified default extraction', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.profile.contentSelector = '';
  p.state.detectionWarnings = ['未自动识别正文，请点选正文区域'];
  await p.api.detect();
  assert.equal(p.document.getElementById('start').disabled, false);
  assert.equal(p.document.getElementById('pick-content').disabled, false);
  assert.equal(p.document.getElementById('calibration')?.open, true);
  assert.match(p.document.getElementById('recognition-message')?.textContent || '', /正文/);
  await p.api.run();
  assert.equal(p.state.verified.length, 1);
  assert.equal(p.state.captured.length, 2);
});
test('an empty chapter discovery provides its warning and a calibration action instead of an enabled start', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.discoveredChapters = [];
  p.state.profile.tocSelector = '#new-directory';
  p.state.discoveryWarnings = ['目录路径重复，已排除歧义章节'];
  p.document.getElementById('detect').click();
  await p.settle();
  assert.equal(p.document.getElementById('start').disabled, true);
  assert.equal(p.document.getElementById('pick-toc').disabled, false);
  const message = p.document.getElementById('recognition-message')?.textContent || '';
  assert.match(message, /章节|目录/);
  assert.match(message, /路径重复/);
});
test('detection warnings remain visible after the task renders and a later clean detection clears them', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.detectionWarnings = ['跨域框架不可访问'];
  await p.api.detect();
  p.api.render();
  assert.match(p.document.getElementById('recognition-message')?.textContent || '', /跨域框架/);
  p.state.detectionWarnings = [];
  await p.api.detect();
  assert.doesNotMatch(
    p.document.getElementById('recognition-message')?.textContent || '',
    /跨域框架/,
  );
});
test('switching document modes marks the current entry accessibly and keeps the matching controls visible', async (t) => {
  const p = await setup(t);
  await p.settle();
  const web = p.document.querySelector('[data-mode="web"]'),
    spec = p.document.querySelector('[data-mode="spec"]');
  assert.equal(web.getAttribute('aria-current'), 'page');
  spec.click();
  assert.equal(spec.getAttribute('aria-current'), 'page');
  assert.equal(web.hasAttribute('aria-current'), false);
  assert.equal(p.document.querySelector('[data-panel="web"]').hidden, true);
  assert.equal(p.document.querySelector('[data-panel="spec"]').hidden, false);
  assert.equal(p.document.getElementById('spec-file').disabled, false);
});
test('returning from a single-interface specification restores the identified web task', async (t) => {
  const p = await setup(t);
  await p.settle();
  await p.api.run();
  const webId = p.api.getTask().taskId;
  p.document.querySelector('[data-mode="spec"]').click();
  await p.api.importSpec(
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'API', version: '1' },
      paths: { '/one': { get: { responses: { 200: { description: 'OK' } } } } },
    }),
    'api.json',
  );
  assert.equal(p.api.getTask().sourceKind, 'openapi');
  p.document.querySelector('[data-mode="web"]').click();
  assert.equal(p.api.getTask().taskId, webId);
  assert.equal(p.document.getElementById('start').disabled, false);
  assert.equal(p.document.getElementById('start').textContent, '继续采集');
});
test('opening a saved specification from the library preserves the current web task', async (t) => {
  const spec = {
    taskId: 'saved-spec',
    sourceKind: 'openapi',
    product: 'API',
    version: '1',
    entry: 'local.json',
    queue: [{ key: 'one', title: 'GET /one', status: 'captured' }],
    pages: { one: { text: 'API body' } },
    status: 'finished',
  };
  const p = await setup(t, { savedTasks: [spec] });
  await p.settle();
  const webId = p.api.getTask().taskId;
  p.document.querySelector('[data-mode="library"]').click();
  await p.settle();
  const specEntry = [...p.document.querySelectorAll('#task-list .task-open')].find((button) =>
    button.textContent.includes('API'),
  );
  assert.ok(specEntry, 'the saved specification must be listed');
  specEntry.click();
  await p.settle();
  assert.equal(p.api.getTask().taskId, spec.taskId);
  p.document.querySelector('[data-mode="web"]').click();
  assert.equal(p.api.getTask().taskId, webId);
  assert.equal(p.document.getElementById('start').disabled, false);
});
test('the library lists source, progress and update time, and deletes a task after confirmation', async (t) => {
  const saved = {
    taskId: 'saved-web',
    sourceKind: 'web',
    product: 'OldManual',
    version: '2.1',
    entry: 'https://manual.test/docs/index',
    profile: seed(),
    queue: [
      { key: 'a', title: 'A', status: 'captured' },
      { key: 'b', title: 'B', status: 'failed' },
    ],
    pages: {},
    status: 'finished',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
  };
  const p = await setup(t, { savedTasks: [saved] });
  await p.settle();
  p.document.querySelector('[data-mode="library"]').click();
  await p.settle();
  const item = [...p.document.querySelectorAll('#task-list .task-item')].find((row) =>
    row.textContent.includes('OldManual'),
  );
  assert.ok(item, 'the saved task must be listed');
  const text = item.textContent;
  assert.match(text, /OldManual/);
  assert.match(text, /2\.1/);
  assert.match(text, /已保存 1\/2 章/, 'progress must be shown');
  assert.match(text, /docs\/index/, 'the source entry must be shown');
  assert.match(text, /更新/, 'an update time must be shown');
  assert.match(text, /创建/, 'a creation time must be shown');
  assert.equal(item.querySelector('.task-open').disabled, false);
  p.w.confirm = () => false;
  item.querySelector('.danger').click();
  await p.settle();
  assert.equal(p.disk.has('saved-web'), true, 'a declined confirmation must not delete anything');
  p.w.confirm = () => true;
  item.querySelector('.danger').click();
  await p.settle();
  assert.equal(p.disk.has('saved-web'), false, 'confirming must delete the task');
  assert.doesNotMatch(
    p.document.querySelector('#task-list').textContent,
    /OldManual/,
    'the deleted task must disappear from the list',
  );
});
test('returning to the web task restores a retry timer that expired while viewing a specification', async (t) => {
  const p = await setup(t);
  await p.settle();
  let callback,
    timerNumber = 0;
  const clock = p.api.retryClock;
  clock.setTimer = (fn) => {
    callback = fn;
    return ++timerNumber;
  };
  clock.clearTimer = () => {};
  p.state.verifyError = 'Failed to fetch';
  await p.api.run();
  const original = p.api.getTask().taskId;
  p.document.querySelector('[data-mode="spec"]').click();
  await p.api.importSpec(
    JSON.stringify({ openapi: '3.0.3', info: { title: 'API', version: '1' }, paths: {} }),
    'empty.json',
  );
  await callback();
  assert.equal(clock.timer, null);
  p.state.verifyError = null;
  p.document.querySelector('[data-mode="web"]').click();
  assert.equal(p.api.getTask().taskId, original);
  assert.notEqual(clock.timer, null);
  await callback();
  await p.settle();
  assert.equal(p.state.captured.length, 2);
  clock.dispose();
});
test('two selected samples still require a nonempty directory before whole-book collection', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.discoveredChapters = [];
  p.state.picked = { selector: '#custom-toc' };
  p.document.getElementById('pick-toc').click();
  await p.settle();
  p.state.picked = { url: 'https://manual.test/docs/A', title: 'A' };
  await p.api.sample(0);
  p.state.picked = { url: 'https://manual.test/docs/C', title: 'C' };
  await p.api.sample(1);
  await p.api.verifyAndSave();
  p.api.render();
  assert.equal(p.document.getElementById('start').disabled, true);
  assert.match(p.document.getElementById('recognition-message').textContent, /未找到可采集章节/);
  p.state.discoveredChapters = ['A', 'C'].map((title) => ({
    title,
    url: 'https://manual.test/docs/' + title,
  }));
  await p.api.scan();
  assert.equal(p.document.getElementById('start').disabled, false);
});
test('edited selectors verify and capture in a new task without replacing earlier pages', async (t) => {
  const p = await setup(t);
  await p.settle();
  const oldId = p.api.getTask().taskId;
  p.document.getElementById('content-selector').value = '#article';
  await p.api.run();
  assert.notEqual(p.api.getTask().taskId, oldId);
  assert.ok(p.disk.has(oldId));
  assert.ok(p.state.captured.every((profile) => profile.contentSelector === '#article'));
  assert.equal(p.api.getTask().profile.contentSelector, p.api.getProfile().contentSelector);
});
test('a denied task lock leaves another task running and scan does not overwrite its metadata', async (t) => {
  const p = await setup(t);
  await p.settle();
  const task = p.api.getTask();
  task.status = 'running';
  task.queue[0].status = 'processing';
  p.disk.set(task.taskId, structuredClone(task));
  p.held.add('task:' + task.taskId);
  await assert.rejects(p.api.scan(), /另一个|正在/);
  assert.equal(p.disk.get(task.taskId).status, 'running');
  assert.equal(p.disk.get(task.taskId).queue[0].status, 'processing');
});
test('sample B selected first stays in the B slot when A is selected later', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.picked = { url: 'https://manual.test/docs/B', title: 'B' };
  await p.api.sample(1);
  p.state.picked = { url: 'https://manual.test/docs/A', title: 'A' };
  await p.api.sample(0);
  await p.api.verifyAndSave();
  assert.deepEqual(
    p.state.verified.at(-1).samples.map((c) => c.title),
    ['A', 'B'],
  );
});
test('trial can be interrupted from the control page and cannot mutate targets while running', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [{ selector: '#a', title: 'A' }],
  });
  const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
  await p.settle();
  assert.equal(p.state.rotation.running, true);
  assert.equal(p.document.querySelector('#rotation-targets button').disabled, true);
  p.document.getElementById('rotation-stop').click();
  await p.settle();
  assert.equal(p.state.rotation.running, false);
  await trial;
  assert.equal(p.api.getRotationVerified(), false);
});

test('all panel previews replace embedded image payloads with a readable offline-image note', async (t) => {
  const p = await setup(t);
  await p.settle();
  const page = {
    status: 'ok',
    title: '示意图',
    text: '正常正文',
    markdown:
      '正常正文\n![拓扑](data:image/png;base64,QUJDREVGRw==)\n<img alt="截图" src="data:image/png;base64,SElKS0w=">\n',
  };
  const check = () => {
    const value = p.document.getElementById('preview').textContent;
    assert.match(value, /正常正文/);
    assert.match(value, /图片：拓扑，导出离线HTML可查看/);
    assert.match(value, /图片：截图，导出离线HTML可查看/);
    assert.doesNotMatch(value, /data:image|QUJDREVGRw|SElKS0w/);
  };
  p.state.previewPage = page;
  await p.api.previewCurrent();
  check();
  p.state.verificationPreviews = [page, page];
  await p.api.verifyAndSave();
  check();
  p.api.getTask().pages = { one: page };
  p.api.render();
  check();
  assert.match(page.markdown, /QUJDREVGRw/);
});
test('panel rejects specification files above 16 MiB before reading or parsing', async (t) => {
  const p = await setup(t);
  await p.settle();
  let read = false;
  Object.defineProperty(p.document.getElementById('spec-file'), 'files', {
    value: [
      {
        size: 16 * 1024 * 1024 + 1,
        name: 'large.json',
        text: async () => {
          read = true;
          return '{}';
        },
      },
    ],
  });
  await p.document.getElementById('spec-file').onchange();
  assert.equal(read, false);
  assert.match(p.document.getElementById('error').textContent, /16MiB/);
  await assert.rejects(p.api.importSpec(' '.repeat(16 * 1024 * 1024 + 1), 'large.json'), /16MiB/);
});

function storedTask(
  p,
  { product = 'Custom IPS', version = '2026.9', updatedAt = '2026-09-16T00:00:00Z' } = {},
) {
  const task = createTask(p, product, version);
  task.updatedAt = updatedAt;
  task.queue = [
    {
      key: 'url:https://manual.test/docs/A',
      url: 'https://manual.test/docs/A',
      title: 'A',
      status: 'captured',
    },
  ];
  task.pages = { [task.queue[0].key]: { status: 'ok', text: 'saved content' } };
  return task;
}
test('an unfamiliar manual under the same scope gets detection and a separate task', async (t) => {
  const original = seed(),
    old = storedTask(original);
  const p = await setup(t, {
    savedProfiles: [original],
    savedTasks: [old],
    currentURL: 'https://manual.test/docs/other',
  });
  await p.settle();
  assert.equal(p.api.getProfile().entry, 'https://manual.test/docs/other');
  assert.notEqual(p.api.getTask().taskId, old.taskId);
  assert.equal(p.state.detected, 1);
  assert.equal(p.disk.get(old.taskId).pages[old.queue[0].key].text, 'saved content');
});
test('reopening a known chapter restores the newest proven profile and custom product/version', async (t) => {
  const a = seed(),
    b = { ...seed(), id: 'second', contentSelector: '#body' };
  const older = storedTask(a, { updatedAt: '2026-09-15T00:00:00Z' }),
    recent = storedTask(b, { product: 'My appliance', version: 'release 42' });
  const p = await setup(t, {
    savedProfiles: [a, b],
    savedTasks: [older, recent],
    currentURL: 'https://manual.test/docs/A',
  });
  await p.settle();
  assert.equal(p.api.getProfile().id, 'second');
  assert.equal(p.api.getTask().taskId, recent.taskId);
  assert.equal(p.document.getElementById('product').value, 'My appliance');
  assert.equal(p.document.getElementById('version').value, 'release 42');
  assert.equal(p.api.getTask().queue[0].status, 'captured');
  assert.equal(p.state.detected, 0);
});
test('ambiguous historical profiles trigger fresh recognition without a configuration chooser', async (t) => {
  const a = seed(),
    b = { ...seed(), id: 'second' };
  const p = await setup(t, { savedProfiles: [a, b] });
  await p.settle();
  assert.ok(p.api.getProfile());
  assert.ok(p.api.getTask());
  assert.equal(p.state.detected, 1);
  assert.equal(p.document.getElementById('profile-list'), null);
  assert.equal(p.document.getElementById('source-purpose'), null);
  assert.equal(p.document.getElementById('start').disabled, false);
});

test('transient capture failure schedules automatic recovery and resumes only unsaved chapters', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.captureError = 'Failed to fetch';
  await p.api.run();
  const failed = p.api.getTask();
  assert.equal(failed.autoRecovery.enabled, true);
  assert.ok(failed.autoRecovery.nextAttemptAt - Date.now() > 4000);
  p.state.captureError = null;
  await p.api.retryAutomatically(failed.taskId);
  await p.settle();
  assert.equal(p.api.getTask().queue.filter((c) => c.status === 'captured').length, 2);
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
  assert.equal(p.state.recovered, 1);
});
test('a temporary preflight error also gets a retry deadline', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.verifyError = 'Failed to fetch';
  await p.api.run();
  assert.equal(p.api.getTask().autoRecovery.enabled, true);
  assert.ok(p.disk.get(p.api.getTask().taskId).autoRecovery.nextAttemptAt);
  await p.api.pauseImport();
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
  assert.equal(p.disk.get(p.api.getTask().taskId).autoRecovery.enabled, false);
});
test('duplicate-body review is retained and never scheduled for automatic retry', async (t) => {
  const p = await setup(t);
  await p.settle();
  await p.api.run();
  const task = p.api.getTask();
  task.queue[1].status = 'review';
  task.queue[1].error = 'duplicate';
  p.disk.set(task.taskId, structuredClone(task));
  await p.api.run();
  assert.equal(p.api.getTask().queue[1].status, 'review');
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
});
test('changing task metadata prevents a pending automatic recovery from taking over another task', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.verifyError = 'Failed to fetch';
  await p.api.run();
  const old = p.api.getTask().taskId;
  p.document.getElementById('product').value = 'A different manual';
  await p.api.retryAutomatically(old);
  assert.equal(p.state.recovered || 0, 0);
  assert.equal(p.api.getTask().taskId, old);
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
});

test('reopening the same source login tab restores its persisted recovery plan without fresh detection', async (t) => {
  const profile = seed(),
    saved = createTask(profile, 'Saved product', 'V1');
  saved.status = 'waiting_login';
  saved.recovery = { retryable: true, reason: 'auth' };
  saved.queue = [
    {
      key: 'url:https://manual.test/docs/A',
      url: 'https://manual.test/docs/A',
      title: 'A',
      status: 'captured',
    },
    {
      key: 'url:https://manual.test/docs/C',
      url: 'https://manual.test/docs/C',
      title: 'C',
      status: 'waiting_login',
    },
  ];
  saved.pages = { [saved.queue[0].key]: { status: 'ok', text: 'already saved' } };
  saved.autoRecovery = {
    enabled: true,
    nextAttemptAt: Date.now() + 180000,
    attempts: 2,
    sourceTabId: 1,
  };
  const p = await setup(t, {
    savedTasks: [saved],
    savedSettings: [['recovery-tab:1', saved.taskId]],
    currentURL: 'https://manual.test/login',
  });
  await p.settle();
  assert.equal(p.api.getTask().taskId, saved.taskId);
  assert.equal(p.api.getTask().autoRecovery.attempts, 2);
  assert.equal(p.state.detected, 0);
  assert.equal(p.api.getTask().pages[saved.queue[0].key].text, 'already saved');
  await p.api.pauseImport();
});

test('a controller cannot reclaim automatic recovery after the task was bound to another source tab', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.verifyError = 'Failed to fetch';
  await p.api.run();
  const local = p.api.getTask();
  const saved = structuredClone(local);
  saved.autoRecovery.sourceTabId = 9;
  p.disk.set(saved.taskId, saved);
  await p.api.retryAutomatically(local.taskId);
  assert.equal(p.state.recovered || 0, 0);
  assert.equal(p.disk.get(saved.taskId).autoRecovery.sourceTabId, 9);
  await p.api.pauseImport();
});
test('a newer persisted retry deadline is honored instead of a stale controller starting immediately', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.verifyError = 'Failed to fetch';
  await p.api.run();
  const local = p.api.getTask();
  const saved = structuredClone(local);
  saved.autoRecovery.nextAttemptAt += 180000;
  p.disk.set(saved.taskId, saved);
  await p.api.retryAutomatically(local.taskId);
  assert.equal(p.state.recovered || 0, 0);
  assert.equal(
    p.disk.get(saved.taskId).autoRecovery.nextAttemptAt,
    saved.autoRecovery.nextAttemptAt,
  );
  await p.api.pauseImport();
});
test('pausing during source preflight prevents subsequent sample navigation', async (t) => {
  const p = await setup(t);
  await p.settle();
  let release;
  p.state.installGate = new Promise((r) => (release = r));
  const running = p.api.run();
  await p.settle();
  assert.equal(p.document.getElementById('pause').disabled, false);
  await p.api.pauseImport();
  release();
  await running;
  assert.equal(p.state.verified.length, 0);
  assert.equal(p.state.captured.length, 0);
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
});

test('reopening an interrupted running task persists its new retry deadline before scheduling', async (t) => {
  const profile = seed(),
    saved = createTask(profile, 'Interrupted', 'V1');
  saved.status = 'running';
  saved.autoRecovery = { enabled: true, nextAttemptAt: null, attempts: 0, sourceTabId: 1 };
  saved.queue = [
    {
      key: 'url:https://manual.test/docs/A',
      url: 'https://manual.test/docs/A',
      title: 'A',
      status: 'processing',
    },
    {
      key: 'url:https://manual.test/docs/C',
      url: 'https://manual.test/docs/C',
      title: 'C',
      status: 'pending',
    },
  ];
  const p = await setup(t, {
    savedTasks: [saved],
    savedSettings: [['recovery-tab:1', saved.taskId]],
    currentURL: profile.entry,
  });
  await p.settle();
  const deadline = p.api.getTask().autoRecovery.nextAttemptAt;
  assert.ok(deadline > Date.now());
  assert.equal(p.disk.get(saved.taskId).autoRecovery.nextAttemptAt, deadline);
  await p.api.retryAutomatically(saved.taskId);
  assert.equal(p.state.recovered, 1);
  assert.equal(p.api.getTask().queue.filter((c) => c.status === 'captured').length, 2);
  assert.equal(p.api.getTask().autoRecovery.enabled, false);
});

test('a successful navigation trial remains valid when only the click interval changes', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [{ selector: '#a', title: 'A' }],
  });
  const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
  await p.settle();
  await trial;
  assert.equal(p.api.getRotationVerified(), true);
  p.document.getElementById('rotation-interval').value = '120';
  p.document.getElementById('rotation-interval').dispatchEvent(new p.w.Event('change'));
  p.document.getElementById('rotation-start').click();
  await p.settle();
  assert.equal(p.document.getElementById('error').textContent, '');
  assert.equal(p.state.rotation.running, true);
  p.document.querySelector('#rotation-targets button').click();
  await p.settle();
  assert.equal(p.api.getRotationVerified(), false, 'removing a target still requires a new trial');
});

test('a saved task from another origin stays listed and selectable, and a stale running task is marked interrupted', async (t) => {
  const foreign = profiles.validateProfile({
    ...seed(),
    id: 'foreign',
    entry: 'https://other.test/docs/index',
  });
  const task = {
    schemaVersion: 2,
    taskId: 'foreign-task',
    profileId: 'foreign',
    profileRevision: 1,
    profile: foreign,
    entry: foreign.entry,
    sourceKind: 'web',
    product: 'IPS',
    version: '1',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    status: 'running',
    queue: [
      {
        key: 'url:https://other.test/docs/A',
        url: 'https://other.test/docs/A',
        title: 'A',
        status: 'captured',
      },
    ],
    pages: {},
    discoveryWarnings: [],
    scanDiagnostics: {},
  };
  const p = await setup(t, { savedTasks: [task], currentURL: 'https://manual.test/docs/index' });
  await p.settle();
  assert.equal(
    p.disk.get('foreign-task').status,
    'paused',
    'a task left running by a closed console is recognised as interrupted, not live',
  );
  p.document.querySelector('[data-mode="library"]').click();
  await p.settle();
  // The console also auto-created a task for this tab; pick the foreign one.
  const item = [...p.document.querySelectorAll('#task-list .task-item')].find((li) =>
    li.textContent.includes('other.test'),
  );
  assert.ok(item, 'the task must be listed even though its origin differs from this tab');
  assert.doesNotMatch(item.textContent, /正在采集/);
  const open = item.querySelector('.task-open');
  assert.equal(open.disabled, false, 'the task must be selectable without matching origin');
  open.click();
  await p.settle();
  assert.match(
    p.document.getElementById('error').textContent,
    /other\.test/,
    'binding is refused with the reason, not silently matched by origin',
  );
  assert.equal(
    p.api.getTask().taskId,
    'foreign-task',
    'the task is still loaded so the user can switch tabs and retry',
  );
});
test('an error shown in the console never carries a credential from the message', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.error(
    new Error(
      'GET https://docs.test/api/toc?token=SECRETTOKEN failed: Authorization: Bearer eyJabc.def ; Cookie: sess=XYZ',
    ),
  );
  const shown = p.document.getElementById('error').textContent;
  assert.ok(!shown.includes('SECRETTOKEN'), 'token leaked into the console: ' + shown);
  assert.ok(!shown.includes('eyJabc'), 'bearer credential leaked into the console: ' + shown);
  assert.ok(!shown.includes('sess=XYZ'), 'cookie leaked into the console: ' + shown);
  assert.match(shown, /docs\.test\/api/, 'the path is still shown for diagnosis');
});
test('the stored error log is redacted again when it is rendered', async (t) => {
  const p = await setup(t);
  await p.settle();
  await p.api.run();
  const task = p.api.getTask();
  task.errorLog = [
    {
      name: 'Error',
      message: 'token=RAWSECRET',
      stack: 'at f (https://docs.test/api?token=RAWSECRET)',
      stage: 'capture-chapter',
      chapterTitle: 'C1',
      at: new Date().toISOString(),
    },
  ];
  task.queue[0].status = 'failed';
  p.api.render();
  const shown = p.document.getElementById('error-log').textContent;
  assert.ok(!shown.includes('RAWSECRET'), 'a raw fault rendered without redaction: ' + shown);
  assert.match(shown, /C1/, 'the chapter identity is still shown');
});

test('deletion cannot race an active collector or resurrect its task', async (t) => {
  const p = await setup(t);
  await p.settle();
  const task = p.api.getTask();
  p.held.add('task:' + task.taskId);
  p.w.confirm = () => true;
  p.document.querySelector('[data-mode="library"]').click();
  await p.settle();
  p.document.querySelector('#task-list .danger').click();
  await p.settle();
  assert.equal(
    p.disk.has(task.taskId),
    true,
    'a collector holding the task lock must keep its data',
  );
  assert.match(p.document.getElementById('error').textContent, /采集|使用|暂停/);
});

test('opening a live task is read-only and cannot steal its recovery binding', async (t) => {
  const p = await setup(t);
  await p.settle();
  const saved = structuredClone(p.api.getTask());
  saved.status = 'running';
  saved.autoRecovery = { enabled: true, sourceTabId: 9, nextAttemptAt: null };
  p.disk.set(saved.taskId, saved);
  p.held.add('task:' + saved.taskId);
  p.state.previewPage = { ok: true };
  await p.api.openTask(saved);
  assert.equal(p.disk.get(saved.taskId).status, 'running');
  assert.equal(p.disk.get(saved.taskId).autoRecovery.sourceTabId, 9);
});

test('re-detecting unchanged rules reuses saved task identity and pages', async (t) => {
  const p = await setup(t);
  await p.settle();
  await p.api.run();
  const first = structuredClone(p.api.getTask());
  await p.api.detect();
  assert.equal(p.api.getTask().taskId, first.taskId);
  assert.deepEqual(p.api.getTask().pages, first.pages);
});

test('selected source applies edited product and version before starting its session', async (t) => {
  const p = await setup(t);
  await p.settle();
  await p.api.run();
  const old = structuredClone(p.api.getTask());
  let received;
  const session = {
    busy: false,
    getState: () => ({ canPause: false }),
    adopt(task, profile) {
      this.task = task;
      this.profile = profile;
    },
    start: async () => {
      received = structuredClone(session.task);
    },
  };
  session.task = p.api.getTask();
  session.profile = p.api.getProfile();
  p.api.setSession(session);
  p.document.getElementById('product').value = 'New product';
  p.document.getElementById('version').value = 'V2';
  p.document.getElementById('start').click();
  await p.settle();
  assert.equal(received?.product, 'New product');
  assert.equal(received?.version, 'V2');
  assert.notEqual(received.taskId, old.taskId);
  assert.deepEqual(p.disk.get(old.taskId).pages, old.pages);
});

test('a source with ambiguous saved rules still offers rule selection and re-detection', async (t) => {
  const p = await setup(t, { savedProfiles: [seed()] });
  await p.settle();
  const session = {
    tabId: 1,
    io: p.api.getIO(),
    profile: null,
    task: null,
    busy: false,
    getState: () => ({ canPause: false }),
  };
  await p.api.selectSession(session);
  assert.equal(p.document.getElementById('detect').disabled, false);
  assert.equal(p.document.getElementById('detect').disabled, false);
  assert.equal(p.document.getElementById('start').disabled, true);
});

test('importing the same specification twice reuses its saved pages without a revision conflict', async (t) => {
  const p = await setup(t);
  await p.settle();
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  Object.assign(p.w, { saveWholeTask: realStore.saveWholeTask, loadTask: realStore.loadTask });
  const input = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Repeat', version: '1' },
    paths: { '/one': { get: { responses: { 200: { description: 'OK' } } } } },
  });
  await p.api.importSpec(input, 'repeat.json');
  const first = structuredClone(p.api.getTask());
  await assert.doesNotReject(p.api.importSpec(input, 'repeat.json'));
  assert.deepEqual(p.api.getTask().pages, first.pages);
});
test('same-origin specification import does not adopt a specification into a web source', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = {
    busy: false,
    getState: () => ({ canPause: false }),
    adopt(task) {
      assert.equal(task.sourceKind, 'web');
    },
  };
  p.api.setSession(session);
  p.document.getElementById('spec-url').value = 'https://manual.test/spec.json';
  p.w.chrome.scripting.executeScript = async () => [
    {
      result: JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Local', version: '1' },
        paths: {},
      }),
    },
  ];
  await assert.doesNotReject(p.api.locked(p.api.fetchSpec));
  assert.equal(p.api.getTask().sourceKind, 'openapi');
});
test('late source selection cannot overwrite a newer selection connection or IO', async (t) => {
  const p = await setup(t);
  await p.settle();
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    base = p.api.getIO();
  const make = (id, url, tab) => ({
    tabId: id,
    io: { ...base, tab },
    task: null,
    profile: null,
    busy: false,
    getState: () => ({ canPause: false }),
  });
  const a = make(11, 'https://a.test/docs', async () => {
    await gate;
    return { url: 'https://a.test/docs' };
  });
  const b = make(12, 'https://b.test/docs', async () => ({ url: 'https://b.test/docs' }));
  const selecting = p.api.selectSession(a);
  await p.api.selectSession(b);
  release();
  await selecting;
  assert.match(p.document.getElementById('connection').textContent, /b\.test/);
  assert.equal((await p.api.getIO().tab()).url, 'https://b.test/docs');
});

test('selecting an empty busy source clears the previous source preview', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.document.getElementById('preview').textContent = 'SOURCE A SAVED BODY';
  await p.api.selectSession({
    tabId: 3,
    io: p.api.getIO(),
    task: null,
    profile: null,
    busy: true,
    getState: () => ({ canPause: true }),
  });
  assert.equal(p.document.getElementById('preview').textContent, '尚无已保存正文');
});

test('a specification sync cannot replace the selected web source task', async (t) => {
  const p = await setup(t);
  await p.settle();
  const original = p.api.getTask();
  const session = {
    task: original,
    profile: p.api.getProfile(),
    busy: false,
    getState: () => ({ canPause: false }),
  };
  p.api.setSession(session);
  await p.api.importSpec(
    JSON.stringify({ openapi: '3.0.3', info: { title: 'Spec', version: '1' }, paths: {} }),
    'spec.json',
  );
  const spec = p.api.getTask();
  await p.state.notifyTasks({ taskId: spec.taskId, type: 'saved' });
  assert.equal(session.task.taskId, original.taskId);
  assert.equal(session.task.sourceKind, 'web');
  assert.equal(p.api.getTask().sourceKind, 'openapi');
});

test('a saved task from another origin opens a visible read-only preview', async (t) => {
  const archived = createTask(seed(), 'Archived manual', '1');
  archived.pages = { saved: { text: 'ARCHIVED SOURCE BODY' } };
  const p = await setup(t, { savedTasks: [archived], currentURL: 'https://else.test/other' });
  await p.settle();
  p.api.setSession({ task: p.api.getTask(), busy: true, getState: () => ({ canPause: true }) });
  p.document.querySelector('[data-mode="library"]').click();
  await p.settle();
  await p.api.openTask(archived);
  assert.equal(p.document.querySelector('.app').dataset.currentMode, 'web');
  assert.match(p.document.getElementById('preview').textContent, /ARCHIVED SOURCE BODY/);
  assert.equal(p.document.getElementById('start').disabled, true);
  assert.equal(p.document.getElementById('pause').disabled, true);
});

test('connecting a control page keeps the rotation view without discovering a manual', async (t) => {
  const p = await setup(t);
  await p.settle();
  let initialized = 0;
  const previousTask = p.api.getTask();
  const session = {
    tabId: 11,
    io: p.api.getIO(),
    task: null,
    profile: null,
    busy: false,
    initialize: async () => {
      initialized++;
    },
    getState: () => ({ canPause: false }),
  };
  await p.api.selectSession(session, { view: 'rotation' });
  assert.equal(initialized, 0);
  assert.equal(p.document.querySelector('.app').dataset.currentMode, 'rotation');
  assert.equal(p.document.getElementById('rotation-preset').disabled, false);
  assert.equal(p.api.getTask(), previousTask);
});

test('rotation cannot act on the previous page while source selection is pending', async (t) => {
  const p = await setup(t);
  await p.settle();
  let release,
    actions = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = p.api.getIO();
  const selecting = p.api.selectSession(
    {
      tabId: 11,
      io: {
        ...base,
        tab: async () => {
          await gate;
          return { url: 'https://other.test/docs' };
        },
      },
      task: null,
      profile: null,
      busy: false,
      getState: () => ({ canPause: false }),
    },
    { view: 'rotation' },
  );
  try {
    assert.equal(p.document.getElementById('rotation-preset').disabled, true);
    await p.api.rotationAction(async () => {
      actions++;
    });
    assert.equal(actions, 0);
  } finally {
    release();
    await selecting;
  }
});

test('switching each workspace section clears only the URL entry', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.document.getElementById('rotation-interval').value = '120';
  p.document.getElementById('content-selector').value = '#keep-article';
  for (const section of ['rotation', 'batch', 'web', 'spec', 'library']) {
    p.document.getElementById('source-url').value = 'https://other.test/new-page';
    p.document.querySelector(`[data-mode="${section}"]`).click();
    await p.settle();
    assert.equal(p.document.getElementById('source-url').value, '', section);
    assert.equal(p.document.getElementById('rotation-interval').value, '120');
    assert.equal(p.document.getElementById('content-selector').value, '#keep-article');
  }
});

test(
  'stopping during trial cleanup cannot publish a successful verification',
  { timeout: 5000 },
  async (t) => {
    const p = await setup(t);
    await p.settle();
    p.api.setRotation({
      origin: 'https://manual.test',
      pathPrefix: '/docs',
      intervalMs: 60000,
      targets: [{ selector: '#a', title: 'A' }],
    });
    let enterCleanup, releaseCleanup;
    const entered = new Promise((resolve) => {
      enterCleanup = resolve;
    });
    const gate = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    p.state.onManagedStop = async () => {
      enterCleanup();
      await gate;
    };
    const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
    await p.settle();
    await entered;
    p.document.getElementById('rotation-stop').click();
    await p.settle();
    releaseCleanup();
    await trial;
    assert.equal(p.api.getRotationVerified(), false);
    assert.doesNotMatch(p.document.getElementById('rotation-status').textContent, /试运行通过/);
    assert.equal(p.document.getElementById('rotation-save').disabled, true);
  },
);

test('a successful unsaved rotation trial survives source reselection without sharing validation', async (t) => {
  const p = await setup(t);
  await p.settle();
  const base = p.api.getIO();
  const makeSession = (tabId, url) => ({
    tabId,
    io: { ...base, tab: async () => ({ url }) },
    task: null,
    profile: null,
    busy: false,
    getState: () => ({ canPause: false }),
  });
  const a = makeSession(11, 'https://manual.test/docs/index');
  const b = makeSession(12, 'https://second.test/admin');
  await p.api.selectSession(a, { view: 'rotation' });
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [{ selector: '#a', title: 'A' }],
  });
  const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
  await p.settle();
  await trial;
  p.document.getElementById('rotation-interval').value = '120';
  await p.api.selectSession(a, { view: 'rotation' });
  assert.equal(
    p.api.getRotationVerified(),
    true,
    'reconnecting the same source must retain its trial',
  );
  assert.equal(p.document.getElementById('rotation-interval').value, '120');
  await p.api.selectSession(b, { view: 'rotation' });
  assert.equal(p.api.getRotationVerified(), false, 'another source has not passed a trial');
  assert.equal(p.document.querySelectorAll('#rotation-targets li').length, 0);
  assert.doesNotMatch(p.document.getElementById('rotation-status').textContent, /试运行通过/);
  p.api.setRotation({
    origin: 'https://second.test',
    pathPrefix: '/admin',
    intervalMs: 60000,
    targets: [{ selector: '#b', title: 'B' }],
  });
  await p.api.selectSession(a, { view: 'rotation' });
  assert.equal(p.api.getRotationVerified(), true);
  assert.match(p.document.querySelector('#rotation-targets li').textContent, /A/);
  p.document.getElementById('rotation-start').click();
  await p.settle();
  assert.equal(p.document.getElementById('error').textContent, '');
  assert.equal(p.state.rotation.running, true);
  p.document.getElementById('rotation-stop').click();
  await p.settle();
  await p.api.selectSession(b, { view: 'rotation' });
  assert.equal(p.api.getRotationVerified(), false);
  assert.match(p.document.querySelector('#rotation-targets li').textContent, /B/);
});

test('a newly connected source can reach recognition settings and discover without starting collection', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = new SourceSession({
    tabId: 11,
    io: p.api.getIO(),
    locks: p.w.navigator.locks,
    store: Object.fromEntries(
      [
        'loadTask',
        'listTasks',
        'saveTask',
        'saveProfile',
        'loadProfiles',
        'getSetting',
        'setSetting',
      ].map((key) => [key, p.w[key]]),
    ),
  });
  t.after(() => session.dispose());
  await session.connect();
  await p.api.selectSession(session, { view: 'batch' });
  const detections = p.state.detected;
  p.document.querySelector('[data-mode="web"]').click();
  await p.settle();
  assert.equal(p.document.querySelector('[data-operation="identify"]').disabled, false);
  assert.equal(p.document.querySelector('[data-operation-panel="identify"]').hidden, false);
  assert.equal(
    p.state.detected,
    detections,
    'switching sections must not start recognition implicitly',
  );
  assert.equal(p.document.getElementById('detect').disabled, false);
  p.document.getElementById('detect').click();
  await p.settle();
  assert.equal(p.state.detected, detections + 1);
  assert.equal(p.document.getElementById('found').textContent, '2');
  assert.equal(session.initialized, true);
  assert.equal(session.task.taskId, p.api.getTask().taskId);
  assert.equal(p.document.getElementById('start').disabled, false);
  assert.deepEqual(p.state.captured, []);
  assert.equal(Object.keys(session.task.pages).length, 0);
});

for (const edit of ['remove', 'import']) {
  test(`a ${edit} after successful rotation trial clears the obsolete success message`, async (t) => {
    const p = await setup(t);
    await p.settle();
    p.api.setRotation({
      origin: 'https://manual.test',
      pathPrefix: '/docs',
      intervalMs: 60000,
      targets: [
        { selector: '#a', title: 'A' },
        { selector: '#b', title: 'B' },
      ],
    });
    const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
    await p.settle();
    await trial;
    assert.match(p.document.getElementById('rotation-status').textContent, /试运行通过/);
    if (edit === 'remove') p.document.querySelector('#rotation-targets button').click();
    else {
      const input = p.document.getElementById('rotation-import');
      Object.defineProperty(input, 'files', {
        value: [
          {
            size: 100,
            text: async () =>
              JSON.stringify({
                format: 'security-navigation-profile',
                schemaVersion: 1,
                config: {
                  origin: 'https://manual.test',
                  pathPrefix: '/docs',
                  intervalMs: 60000,
                  targets: [{ selector: '#c', title: 'C' }],
                },
              }),
          },
        ],
      });
      input.dispatchEvent(new p.w.Event('change'));
      await p.settle();
    }
    assert.equal(p.api.getRotationVerified(), false);
    assert.doesNotMatch(
      p.document.getElementById('rotation-status').textContent,
      /试运行通过|可保存规则或开始轮换/,
    );
    assert.match(p.document.getElementById('rotation-status').textContent, /重新试运行/);
    await p.api.rotationCall('snapshot');
    assert.match(p.document.getElementById('rotation-status').textContent, /重新试运行/);
    assert.equal(p.document.getElementById('rotation-save').disabled, true);
  });
}

function connectedPanelSession(p) {
  return new SourceSession({
    tabId: 11,
    io: p.api.getIO(),
    locks: p.w.navigator.locks,
    store: Object.fromEntries(
      [
        'loadTask',
        'listTasks',
        'saveTask',
        'saveProfile',
        'loadProfiles',
        'getSetting',
        'setSetting',
      ].map((key) => [key, p.w[key]]),
    ),
  });
}
test('returning from batch shows the selected source existing task without detecting again', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await p.api.selectSession(session, { view: 'batch' });
  p.document.querySelector('[data-mode="batch"]').click();
  await session.initialize();
  const detections = p.state.detected;
  p.document.querySelector('[data-mode="web"]').click();
  await p.settle();
  assert.equal(p.api.getTask()?.taskId, session.task.taskId);
  assert.equal(p.document.getElementById('found').textContent, '2');
  assert.equal(p.document.getElementById('start').disabled, false);
  assert.equal(p.state.detected, detections);
});
test('a failed recognition scan cannot adopt its incomplete draft into a connected source', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await p.api.selectSession(session, { view: 'batch' });
  p.state.profile.tocSelector = '';
  p.state.profile.contentSelector = '';
  p.state.discoveredChapters = [];
  await p.api.locked(p.api.detect);
  assert.match(p.document.getElementById('error').textContent, /目录|章节/);
  assert.equal(session.initialized, false);
  assert.equal(session.task, null);
  assert.equal(session.profile, null);
});

test('switching sections keeps an unsaved picked region instead of restoring the older source rule', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await session.initialize();
  await p.api.selectSession(session, { view: 'web' });
  const previousProfile = session.profile.id;
  p.state.picked = { selector: '#new-directory' };
  p.document.getElementById('pick-toc').click();
  await p.settle();
  assert.notEqual(p.api.getProfile().id, previousProfile);
  assert.equal(p.api.getTask(), null);
  p.document.querySelector('[data-mode="batch"]').click();
  p.document.querySelector('[data-mode="web"]').click();
  await p.settle();
  assert.equal(p.api.getProfile().tocSelector, '#new-directory');
  assert.equal(p.document.getElementById('toc-selector').value, '#new-directory');
  assert.equal(p.api.getTask(), null);
});

test('stopping while saving a verified menu does not erase its completed trial', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [{ selector: '#a', title: 'A' }],
  });
  const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
  await p.settle();
  await trial;
  assert.equal(p.api.getRotationVerified(), true);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const save = p.w.setSetting;
  p.w.setSetting = async (...args) => {
    await gate;
    return save(...args);
  };
  p.document.getElementById('rotation-save').click();
  await p.settle();
  try {
    assert.equal(p.document.getElementById('rotation-stop').disabled, false);
    p.document.getElementById('rotation-stop').click();
    await p.settle();
    assert.equal(p.api.getRotationVerified(), true);
  } finally {
    release();
    await p.settle();
  }
  p.document.getElementById('rotation-start').click();
  await p.settle();
  assert.equal(p.document.getElementById('error').textContent, '');
  assert.equal(p.state.rotation.running, true);
  p.document.getElementById('rotation-stop').click();
  await p.settle();
});

test('rotation selection never overwrites the selected document or initializes a management page', async (t) => {
  const p = await setup(t);
  await p.settle();
  const docProfile = seed(),
    docTask = createTask(docProfile, 'Document');
  const docIO = {
    ...p.api.getIO(),
    tab: async () => ({ id: 11, url: 'https://manual.test/docs/index' }),
  };
  const doc = {
    tabId: 11,
    purpose: 'document',
    io: docIO,
    task: docTask,
    profile: docProfile,
    initialized: true,
    getState: () => ({ canPause: false }),
  };
  await p.api.selectSession(doc, { view: 'web' });
  let initialized = 0;
  const management = {
    tabId: 12,
    purpose: 'rotation',
    io: { ...docIO, tab: async () => ({ id: 12, url: 'https://manual.test/framework.php' }) },
    initialize: async () => initialized++,
    getState: () => ({ canPause: false }),
  };
  await p.api.selectSession(management, { view: 'rotation' });
  assert.equal(p.api.getIO(), docIO);
  assert.equal(p.api.getTask(), docTask);
  p.document.querySelector('[data-mode="web"]').click();
  await p.settle();
  assert.equal(initialized, 0);
  assert.equal(p.api.getTask(), docTask);
  assert.equal(p.api.getProfile(), docProfile);
});

for (const purpose of ['document', 'rotation'])
  test(`a removed ${purpose} source cannot finish a pending selection`, async (t) => {
    const p = await setup(t);
    await p.settle();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const session = {
      tabId: 21,
      purpose,
      disposed: false,
      io: {
        ...p.api.getIO(),
        tab: async () => {
          await gate;
          return { id: 21, url: 'https://manual.test/docs/index' };
        },
      },
      task: createTask(seed(), 'Removed'),
      profile: seed(),
      getState: () => ({ canPause: false }),
    };
    const selecting = p.api.selectSession(session, {
      view: purpose === 'rotation' ? 'rotation' : 'web',
    });
    await p.settle();
    session.disposed = true;
    release();
    await selecting;
    assert.notEqual(p.api.getSelected(), session);
    assert.notEqual(p.api.getRotationSession(), session);
  });

test('document collection verifies default extraction before adopting it into the session', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await p.api.selectSession(session, { view: 'web' });
  p.state.profile.contentSelector = '';
  await p.api.locked(p.api.detect);
  assert.equal(session.initialized, false);
  p.document.getElementById('start').click();
  await p.settle();
  assert.equal(p.state.verified.length, 1);
  assert.equal(p.state.captured.length, 2);
  assert.equal(session.task.status, 'finished');
});

test('a new trial waits for a previous managed rotation to finish stopping', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [{ selector: '#a', title: 'A' }],
  });
  let release,
    stopped = 0;
  const gate = new Promise((resolve) => (release = resolve));
  p.api.setController({
    stop: async () => {
      stopped++;
      await gate;
      return { running: false, message: '已停止' };
    },
  });
  const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
  await p.settle();
  assert.equal(stopped, 1);
  assert.equal(p.state.rotation.running, false);
  release();
  await p.settle();
  await trial;
  assert.equal(p.api.getRotationVerified(), true);
});

test('API initialization does not select CLI or management rules stored for the same appliance', async (t) => {
  const profile = (id, path) =>
    profiles.validateProfile({
      ...seed(),
      id,
      adapterId: 'sangfor',
      entry: 'https://manual.test' + path,
      pathPrefix: '/',
      queryKeys: ['index', 'dataID'],
    });
  const api = profile('api-rule', '/adocs.php');
  const cli = profile('cli-rule', '/cdocs.php?index=0&dataID=api-menu-item28');
  const management = profile('management-rule', '/framework.php#/mod_home/index');
  const p = await setup(t, { currentURL: api.entry, savedProfiles: [api, cli, management] });
  await p.settle();
  assert.equal(p.api.getProfile().id, 'api-rule');
  assert.equal(p.document.getElementById('profile-list'), null);
});

test('a source directory scan continues while another document is connected and selected', async (t) => {
  const p = await setup(t);
  await p.settle();
  const a = connectedPanelSession(p);
  t.after(() => a.dispose());
  await a.connect();
  await p.api.selectSession(a, { view: 'web' });
  let release;
  p.state.discoverGate = new Promise((resolve) => {
    release = resolve;
  });
  const b = new SourceSession({
    tabId: 22,
    io: { tab: async () => ({ url: 'https://other.test/docs', title: 'Other manual' }) },
    locks: p.w.navigator.locks,
  });
  t.after(() => b.dispose());
  p.document.getElementById('detect').click();
  await p.settle();
  try {
    assert.equal(a.busy, true, 'scanning belongs to the source session');
    await b.connect();
    await p.api.selectSession(b, { view: 'batch' });
    assert.equal(p.api.getSelected(), b);
    assert.equal(a.busy, true, 'switching sources cannot cancel the scan');
    assert.equal(b.task, null);
  } finally {
    release();
    await p.settle();
  }
  assert.equal(a.task.queue.length, 2);
  assert.equal(p.disk.get(a.task.taskId).queue.length, 2);
  assert.equal(p.api.getSelected(), b, 'late scan must not steal the new selection');
  assert.equal(p.api.getTask(), null, 'late scan cannot replace the new source draft');
  await p.api.selectSession(a, { view: 'web' });
  assert.equal(p.document.getElementById('found').textContent, '2');
  assert.equal(a.busy, false);
});

test('a source refresh cannot replace the panel task during a legacy calibration scan', async (t) => {
  const p = await setup(t, { workspace: true });
  await p.settle();
  const a = connectedPanelSession(p);
  t.after(() => a.dispose());
  p.state.sessions = new Map([[a.tabId, a]]);
  a.onChange = (_state, session) => p.state.batchOptions.onChange(session);
  await a.connect();
  await a.initialize();
  await p.api.selectSession(a, { view: 'web' });
  p.state.discoveredChapters = Array.from({ length: 447 }, (_, index) => ({
    title: 'Chapter ' + index,
    url: 'https://manual.test/docs/chapter-' + index,
  }));
  let release;
  p.state.discoverGate = new Promise((resolve) => {
    release = resolve;
  });
  const scanning = p.api.locked(p.api.scan);
  await p.settle();
  const active = p.api.getTask();
  try {
    await a.refresh();
    assert.equal(
      p.api.getTask(),
      active,
      'refresh must not replace a task owned by the panel operation',
    );
  } finally {
    release();
    await scanning;
  }
  assert.equal(p.api.getTask().queue.length, 449);
  assert.equal(a.task.queue.length, 449);
  assert.equal(p.disk.get(a.task.taskId).queue.length, 449);
});

test('switching document sources preserves edited calibration and product fields separately', async (t) => {
  const p = await setup(t);
  await p.settle();
  const a = connectedPanelSession(p);
  t.after(() => a.dispose());
  await a.connect();
  await a.initialize();
  await p.api.selectSession(a, { view: 'web' });
  p.document.getElementById('product').value = 'API draft';
  p.document.getElementById('toc-selector').value = '#edited-api-toc';
  const b = new SourceSession({
    tabId: 22,
    io: { tab: async () => ({ url: 'https://other.test/docs', title: 'Other' }) },
    locks: p.w.navigator.locks,
  });
  t.after(() => b.dispose());
  await b.connect();
  await p.api.selectSession(b, { view: 'batch' });
  assert.equal(
    p.document.getElementById('toc-selector').value,
    '',
    'an unidentified source must not show another source rules',
  );
  p.document.getElementById('product').value = 'CLI draft';
  await p.api.selectSession(a, { view: 'web' });
  assert.equal(p.document.getElementById('product').value, 'API draft');
  assert.equal(p.document.getElementById('toc-selector').value, '#edited-api-toc');
  await p.api.selectSession(b, { view: 'batch' });
  assert.equal(p.document.getElementById('product').value, 'CLI draft');
});

for (const view of ['web', 'batch', 'spec-import', 'other-source']) {
  test(`background binding repair updates untouched fields in ${view}`, async (t) => {
    const p = await setup(t, { workspace: true });
    await p.settle();
    const a = connectedPanelSession(p);
    const b = new SourceSession({
      tabId: 22,
      io: { tab: async () => ({ url: 'https://other.test/docs', title: 'Other' }) },
      locks: p.w.navigator.locks,
    });
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    p.state.sessions = new Map([
      [a.tabId, a],
      [b.tabId, b],
    ]);
    await a.connect();
    await a.initialize();
    await b.connect();
    await p.api.selectSession(a, { view: 'web' });
    const originalTaskId = a.task.taskId;
    p.document.getElementById('product').value = 'API product draft';
    p.document.getElementById('version').value = 'draft version';
    if (view === 'other-source') await p.api.selectSession(b, { view: 'web' });
    else if (view === 'batch') p.document.querySelector('[data-mode="batch"]').click();
    else if (view === 'spec-import') {
      p.document.querySelector('[data-mode="spec"]').click();
      await p.api.importSpec(
        JSON.stringify({ openapi: '3.0.3', info: { title: 'Spec', version: '1' }, paths: {} }),
        'spec.json',
      );
    }
    a.profile = { ...a.profile, tocSelector: '#stable-tree', contentSelector: '#stable-body' };
    a.task = { ...a.task, profile: a.profile };
    p.state.batchOptions.onChange(a);
    if (view === 'other-source') await p.api.selectSession(a, { view: 'web' });
    else if (view === 'batch' || view === 'spec-import')
      p.document.querySelector('[data-mode="web"]').click();
    await p.settle();
    assert.equal(p.api.getTask().taskId, originalTaskId);
    assert.equal(p.document.getElementById('toc-selector').value, '#stable-tree');
    assert.equal(p.document.getElementById('content-selector').value, '#stable-body');
    if (view !== 'spec-import') {
      assert.equal(p.document.getElementById('product').value, 'API product draft');
      assert.equal(p.document.getElementById('version').value, 'draft version');
    }
  });
}

for (const update of ['mode', 'snapshot']) {
  test(`unscanned manual calibration survives ${update}`, async (t) => {
    const p = await setup(t, { workspace: true });
    await p.settle();
    const session = connectedPanelSession(p);
    t.after(() => session.dispose());
    p.state.sessions = new Map([[session.tabId, session]]);
    await session.connect();
    await p.api.selectSession(session, { view: 'web' });
    p.state.picked = { selector: '#chosen-directory' };
    p.document.getElementById('pick-toc').click();
    await p.settle();
    const before = p.api.getProfile();
    assert.equal(before.tocSelector, '#chosen-directory');
    assert.equal(session.task, null);
    if (update === 'mode') {
      p.document.querySelector('[data-mode="batch"]').click();
      p.document.querySelector('[data-mode="web"]').click();
    } else p.state.batchOptions.onChange(session);
    assert.equal(p.api.getProfile()?.id, before.id);
    assert.equal(p.document.getElementById('toc-selector').value, '#chosen-directory');
  });
}

for (const switchSource of [false, true]) {
  test(`background binding repair preserves edited calibration (switch source: ${switchSource})`, async (t) => {
    const p = await setup(t, { workspace: true });
    await p.settle();
    const a = connectedPanelSession(p);
    const b = new SourceSession({
      tabId: 22,
      io: { tab: async () => ({ url: 'https://other.test/docs', title: 'Other' }) },
      locks: p.w.navigator.locks,
    });
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    p.state.sessions = new Map([
      [a.tabId, a],
      [b.tabId, b],
    ]);
    await a.connect();
    await a.initialize();
    await b.connect();
    await p.api.selectSession(a, { view: 'web' });
    p.state.picked = { title: 'A', url: 'https://manual.test/docs/A' };
    await p.api.locked(() => p.api.sample(0));
    const selectedSamples = p.document.getElementById('samples').textContent;
    p.document.getElementById('toc-selector').value = '#user-selected-tree';
    if (switchSource) await p.api.selectSession(b, { view: 'web' });
    a.profile = { ...a.profile, tocSelector: '#stable-tree', contentSelector: '#stable-body' };
    a.task = { ...a.task, profile: a.profile };
    p.state.batchOptions.onChange(a);
    if (switchSource) await p.api.selectSession(a, { view: 'web' });
    assert.equal(p.document.getElementById('toc-selector').value, '#user-selected-tree');
    assert.equal(p.document.getElementById('content-selector').value, '#stable-body');
    assert.equal(p.document.getElementById('samples').textContent, selectedSamples);
  });
}

test('finishing a directory scan during specification import restores its result on return', async (t) => {
  const p = await setup(t);
  await p.settle();
  const a = connectedPanelSession(p);
  t.after(() => a.dispose());
  await a.connect();
  await p.api.selectSession(a, { view: 'web' });
  let release;
  p.state.discoverGate = new Promise((resolve) => {
    release = resolve;
  });
  p.document.getElementById('detect').click();
  await p.settle();
  p.document.querySelector('[data-mode="spec"]').click();
  await p.api.importSpec(
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Specification', version: '1' },
      paths: {},
    }),
    'spec.json',
  );
  const specification = p.api.getTask();
  release();
  await p.settle();
  assert.equal(p.api.getTask(), specification, 'scan must not replace the visible specification');
  p.document.querySelector('[data-mode="web"]').click();
  await p.settle();
  assert.equal(
    p.api.getTask()?.taskId,
    a.task.taskId,
    'return must show the completed document scan',
  );
  assert.equal(p.document.getElementById('found').textContent, '2');
});

test('one picked sample survives switching between already identified document sources', async (t) => {
  const p = await setup(t);
  await p.settle();
  const a = connectedPanelSession(p);
  const b = connectedPanelSession(p);
  Object.defineProperty(b, 'tabId', { value: 22 });
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  await a.connect();
  await a.initialize();
  await b.connect();
  await b.initialize();
  b.profile = { ...b.profile, id: 'other-profile' };
  b.task = createTask(b.profile, 'Other');
  await p.api.selectSession(a, { view: 'web' });
  p.state.picked = { title: 'A', url: 'https://manual.test/docs/A' };
  await p.api.locked(() => p.api.sample(0));
  const before = p.document.getElementById('samples').textContent;
  assert.match(before, /A：A/);
  await p.api.selectSession(b, { view: 'web' });
  await p.api.selectSession(a, { view: 'web' });
  assert.equal(p.document.getElementById('samples').textContent, before);
});

for (const entry of ['current-scan', 'imported-rule']) {
  test(`${entry} scanning also belongs to the selected source and permits switching`, async (t) => {
    const p = await setup(t);
    await p.settle();
    const a = connectedPanelSession(p);
    t.after(() => a.dispose());
    await a.connect();
    await a.initialize();
    await p.api.selectSession(a, { view: 'web' });
    let release;
    p.state.discoverGate = new Promise((resolve) => {
      release = resolve;
    });
    let scanning;
    if (entry === 'current-scan') {
      p.document.getElementById('scan').click();
    } else {
      const input = p.document.getElementById('import-profile');
      Object.defineProperty(input, 'files', {
        value: [{ size: 100, text: async () => JSON.stringify(a.profile) }],
      });
      scanning = input.onchange();
    }
    await p.settle();
    try {
      assert.equal(a.busy, true, 'every directory entry uses the source operation');
      assert.equal(p.document.getElementById('pause').disabled, false);
      const b = new SourceSession({
        tabId: 22,
        io: { tab: async () => ({ url: 'https://other.test/docs' }) },
        locks: p.w.navigator.locks,
      });
      t.after(() => b.dispose());
      await b.connect();
      await p.api.selectSession(b, { view: 'batch' });
      assert.equal(p.api.getSelected(), b);
    } finally {
      release();
      await scanning;
      await p.settle();
    }
    assert.equal(a.task.queue.length, 2);
  });
}

test('an empty connected source cannot start just because its saved rule has two samples', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  const profile = profiles.validateProfile({
    ...seed(),
    samples: ['A', 'C'].map((title) => ({ title, url: 'https://manual.test/docs/' + title })),
  });
  const empty = createTask(profile, 'Empty manual');
  session.adopt(empty, profile);
  await p.api.selectSession(session, { view: 'web' });
  assert.equal(p.document.getElementById('found').textContent, '0');
  assert.equal(p.document.getElementById('start').disabled, true);
  assert.equal(p.document.getElementById('retry').disabled, true);
  assert.match(p.document.getElementById('recognition-message').textContent, /未找到可采集章节/);
  p.document.getElementById('start').click();
  p.document.getElementById('retry').click();
  await p.settle();
  assert.equal(p.state.captured.length, 0);
  assert.equal(p.state.verified.length, 0);
  assert.equal(session.task.queue.length, 0);
});

test('a newly connected unrecognized source can open calibration and pick regions without detecting first', async (t) => {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await p.api.selectSession(session, { view: 'web' });
  assert.equal(p.api.getProfile(), null);
  const detections = p.state.detected;
  const dialog = p.document.getElementById('calibration-dialog');
  dialog.showModal = () => {
    dialog.open = true;
  };
  assert.equal(p.document.getElementById('open-calibration').disabled, false);
  p.document.getElementById('open-calibration').click();
  assert.equal(dialog.open, true);
  dialog.close = () => {
    dialog.open = false;
  };
  const close = dialog.querySelector('[data-close-dialog]');
  assert.equal(
    close.disabled,
    false,
    'an unrecognized source must not trap the calibration dialog',
  );
  close.click();
  assert.equal(dialog.open, false);
  p.document.getElementById('open-calibration').click();
  assert.equal(p.document.getElementById('pick-toc').disabled, false);
  assert.equal(p.document.getElementById('pick-content').disabled, false);
  assert.equal(p.document.getElementById('start').disabled, true);
  p.state.picked = { selector: '#chosen-directory' };
  p.document.getElementById('pick-toc').click();
  await p.settle();
  assert.equal(p.api.getProfile()?.tocSelector, '#chosen-directory');
  p.state.picked = { selector: '#chosen-body' };
  p.document.getElementById('pick-content').click();
  await p.settle();
  assert.equal(p.api.getProfile()?.contentSelector, '#chosen-body');
  assert.equal(p.state.detected, detections, 'manual setup must not require automatic detection');
  assert.equal(p.document.getElementById('error').textContent, '');
  assert.equal(session.initialized, false, 'picking alone cannot adopt an unscanned task');
  p.document.getElementById('scan').click();
  await p.settle();
  assert.equal(p.document.getElementById('found').textContent, '2');
  assert.equal(p.document.getElementById('start').disabled, false);
});

test('manual region picking remains unavailable without a connected source or during source selection', async (t) => {
  const p = await setup(t, { holdTab: true });
  assert.equal(p.document.getElementById('open-calibration').disabled, true);
  assert.equal(p.document.getElementById('pick-toc').disabled, true);
  p.releaseTab();
  await p.settle();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const session = {
    tabId: 23,
    purpose: 'document',
    io: {
      ...p.api.getIO(),
      tab: async () => {
        await gate;
        return { url: 'https://manual.test/docs/index' };
      },
    },
    getState: () => ({ canPause: false }),
  };
  const selecting = p.api.selectSession(session, { view: 'web' });
  assert.equal(p.document.getElementById('open-calibration').disabled, true);
  assert.equal(p.document.getElementById('pick-toc').disabled, true);
  release();
  await selecting;
});

for (const cancel of [false, true]) {
  test(`trial button takes over a running management source lock${cancel ? ' and can cancel while stopping' : ''}`, async (t) => {
    const p = await setup(t, {
      workspace: true,
      realRotation: true,
      currentURL: 'https://manual.test/framework.php#/mod_home/index',
    });
    const session = {
      tabId: 1,
      purpose: 'rotation',
      io: p.api.getIO(),
      address: p.state.profile.entry,
    };
    p.state.sessions = new Map([[1, session]]);
    await p.api.selectSession(session, { view: 'rotation' });
    p.api.setRotation({
      origin: 'https://manual.test',
      pathPrefix: '/framework.php',
      intervalMs: 60000,
      targets: [{ selector: '#home', title: '主页' }],
    });
    const trialButton = p.document.getElementById('rotation-trial');
    assert.equal(trialButton.disabled, false, 'bound idle management source can trial');
    trialButton.click();
    await waitForTrial(p);
    assert.equal(p.api.getRotationVerified(), true);
    p.document.getElementById('rotation-start').click();
    await p.settle();
    assert.equal((await p.state.controller.snapshot(1)).running, true);
    assert.equal(p.held.has('source-tab:1'), true);
    assert.equal(trialButton.disabled, false, 'trial remains available during normal rotation');
    let releaseStop;
    const stopGate = new Promise((resolve) => {
      releaseStop = resolve;
    });
    p.state.onManagedStop = () => stopGate;
    trialButton.click();
    await p.settle();
    assert.equal(trialButton.disabled, true, 'cannot start a duplicate trial during cleanup');
    assert.equal(p.document.getElementById('rotation-stop').disabled, false);
    assert.equal(p.state.trialPreparations, 1, 'no trial starts before managed cleanup finishes');
    if (cancel) p.document.getElementById('rotation-stop').click();
    releaseStop();
    await waitForTrial(p);
    assert.equal((await p.state.controller.snapshot(1)).running, false);
    assert.equal(
      p.held.has('source-tab:1'),
      false,
      'trial and old rotation both release the source',
    );
    assert.equal(p.api.getRotationVerified(), !cancel);
    assert.equal(p.state.trialPreparations, cancel ? 1 : 2);
    assert.equal(p.state.trialHadLock, true, 'trial clicks remain inside the source lock');
    assert.equal(p.document.getElementById('error').textContent, cancel ? '试运行已取消' : '');
  });
}

test('a replacement management tab is selected after its previous source closes', async (t) => {
  const p = await setup(t, {
    workspace: true,
    currentURL: 'https://manual.test/framework.php#/mod_home/index',
  });
  const first = {
    tabId: 1,
    purpose: 'rotation',
    io: p.api.getIO(),
    address: p.state.profile.entry,
  };
  const next = { ...first, tabId: 3 };
  p.state.sessions = new Map([
    [1, first],
    [3, next],
  ]);
  await p.api.selectSession(first, { view: 'rotation' });
  assert.equal(p.document.getElementById('rotation-trial').disabled, false);
  first.closed = true;
  p.state.batchOptions.onChange(first);
  assert.equal(p.document.getElementById('rotation-trial').disabled, true);
  assert.match(p.document.getElementById('connection').textContent, /已关闭/);
  assert.match(p.document.getElementById('rotation-status').textContent, /已关闭/);
  assert.equal(
    p.document.getElementById('rotation-remove').disabled,
    false,
    'closed source can be removed',
  );
  await p.state.batchOptions.onAdded(next);
  assert.equal(p.api.getRotationSession(), next);
  assert.equal(p.document.getElementById('rotation-trial').disabled, false);
  assert.doesNotMatch(p.document.getElementById('connection').textContent, /已关闭/);
  assert.doesNotMatch(p.document.getElementById('rotation-status').textContent, /已关闭/);
  const another = { ...next, tabId: 4 };
  p.state.sessions.set(4, another);
  await p.state.batchOptions.onAdded(another);
  assert.equal(
    p.api.getRotationSession(),
    next,
    'new connections do not replace a valid selection',
  );
});

test('remove actually detaches a closed management source without accessing its dead tab', async (t) => {
  const p = await setup(t, { workspace: true, realRotation: true });
  const session = {
    tabId: 1,
    purpose: 'rotation',
    io: { ...p.api.getIO() },
    address: p.state.profile.entry,
  };
  p.state.sessions = new Map([[1, session]]);
  await p.api.selectSession(session, { view: 'rotation' });
  session.closed = true;
  session.io.tab = async () => {
    throw new Error('原标签页已关闭');
  };
  p.state.batchOptions.onChange(session);
  p.document.getElementById('rotation-remove').click();
  await p.settle();
  assert.deepEqual(p.state.removedSources, [1]);
  assert.equal(p.api.getRotationSession(), null);
  assert.equal(p.document.getElementById('error').textContent, '');
});

test('a previously closed management source can be selected to inspect its draft and remove it', async (t) => {
  const p = await setup(t, {
    workspace: true,
    realRotation: true,
    currentURL: 'https://manual.test/framework.php#/mod_home/index',
  });
  const first = {
    tabId: 1,
    purpose: 'rotation',
    io: { ...p.api.getIO() },
    address: p.state.profile.entry,
  };
  const next = { ...first, tabId: 3, io: p.api.getIO() };
  p.state.sessions = new Map([
    [1, first],
    [3, next],
  ]);
  await p.api.selectSession(first, { view: 'rotation' });
  p.api.setRotation({
    origin: 'https://manual.test',
    pathPrefix: '/framework.php',
    intervalMs: 90000,
    targets: [{ selector: '#home', title: 'Unpersisted home' }],
  });
  p.document.getElementById('rotation-interval').value = '90';
  first.closed = true;
  first.io.tab = async () => {
    throw new Error('closed source must not be contacted');
  };
  await p.state.batchOptions.onAdded(next);
  assert.equal(p.api.getRotationSession(), next);
  await p.api.selectSession(first, { view: 'rotation' });
  assert.equal(p.api.getRotationSession(), first);
  assert.equal(p.document.getElementById('rotation-interval').value, '90');
  assert.match(p.document.getElementById('rotation-targets').textContent, /Unpersisted home/);
  assert.match(p.document.getElementById('rotation-status').textContent, /已关闭/);
  assert.equal(p.document.getElementById('rotation-trial').disabled, true);
  assert.equal(p.document.getElementById('rotation-start').disabled, true);
  assert.equal(p.document.getElementById('rotation-remove').disabled, false);
  p.document.getElementById('rotation-remove').click();
  await p.settle();
  assert.deepEqual(p.state.removedSources, [1]);
  assert.equal(p.state.sessions.get(3), next);
  assert.equal(p.document.getElementById('error').textContent, '');
});

// Execute the actual source runner; advance its clock while the panel waits for
// a browser response. This recreates a slow observation without faking counts.
async function attachRotationPage(t, p) {
  const scripts = await Promise.all(
    ['navigation-discovery.js', 'navigation-rotation.js'].map((name) =>
      readFile(new URL('../extension/' + name, import.meta.url), 'utf8'),
    ),
  );
  const w = new JSDOM(
    '<nav><button id="objects">对象</button><button id="network">网络</button></nav>',
    {
      url: p.state.profile.entry,
      runScripts: 'outside-only',
    },
  ).window;
  t.after(() => w.close());
  w.HTMLElement.prototype.getClientRects = () => [{}];
  let now = 0,
    serial = 0;
  const timers = new Map(),
    clicks = [];
  w.setTimeout = (fn, delay) => {
    timers.set(++serial, { fn, at: now + delay });
    return serial;
  };
  w.clearTimeout = (id) => timers.delete(id);
  function advance(ms) {
    const end = now + ms;
    for (let i = 0; i < 100; i++) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {
        now = end;
        return;
      }
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    throw new Error('too many source timers');
  }
  w.document
    .querySelector('nav')
    .addEventListener('click', (event) => clicks.push(event.target.textContent));
  p.w.chrome.scripting.executeScript = async ({ files, func, args = [] }) => {
    if (files) {
      scripts.forEach((script) => w.eval(script));
      return [];
    }
    const result = w.eval('(' + func.toString() + ')')(...args);
    if (!['stop', 'stopManaged'].includes(args[0])) advance(3000);
    return [{ result }];
  };
  p.api.setRotation({
    origin: w.location.origin,
    pathPrefix: '/docs',
    intervalMs: 60000,
    targets: [
      { selector: '#objects', title: '对象' },
      { selector: '#network', title: '网络' },
    ],
  });
  return { w, clicks, timers, advance };
}

test(
  'a slow trial response cannot run another lap or discard completed menu verification',
  { timeout: 8000 },
  async (t) => {
    const p = await setup(t);
    await p.settle();
    const page = await attachRotationPage(t, p);
    await p.api.rotationAction(p.api.rotationTrial, { source: false });
    assert.equal(
      p.document.getElementById('error').textContent,
      '',
      'normal progress must not become an error',
    );
    assert.deepEqual(page.clicks, ['对象', '网络'], 'trial must execute exactly one finite pass');
    assert.equal(p.api.getRotationVerified(), true);
    assert.equal(page.timers.size, 0);
    assert.equal(p.held.size, 0);
    assert.equal(page.w.SecurityNavigationRotation.snapshot().running, false);
    p.document.getElementById('rotation-start').click();
    await p.settle();
    assert.equal(p.document.getElementById('error').textContent, '');
    assert.equal(page.w.SecurityNavigationRotation.snapshot().running, true);
    p.document.getElementById('rotation-stop').click();
    await p.settle();
  },
);

async function waitForTrial(p) {
  const deadline = Date.now() + 5000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!p.document.getElementById('rotation-trial').disabled) return;
  } while (Date.now() < deadline);
  assert.fail('trial did not settle in five seconds');
}

for (const failure of ['missing-menu', 'source-stop', 'lost-result']) {
  test(
    `a finite trial handles ${failure} without verification or another click`,
    { timeout: 8000 },
    async (t) => {
      const p = await setup(t);
      await p.settle();
      const page = await attachRotationPage(t, p);
      if (failure === 'missing-menu')
        page.w.document.querySelector('#objects').onclick = () =>
          page.w.document.querySelector('#network').remove();
      if (failure === 'source-stop')
        page.w.document.querySelector('#objects').onclick = () =>
          page.w.SecurityNavigationRotation.stop();
      if (failure === 'lost-result') {
        const executeScript = p.w.chrome.scripting.executeScript;
        p.w.chrome.scripting.executeScript = async (options) => {
          const result = await executeScript(options);
          if (options.args?.[0] === 'execute') throw new Error('Execution context was destroyed');
          return result;
        };
      }
      await p.api.rotationAction(p.api.rotationTrial, { source: false });
      assert.equal(p.api.getRotationVerified(), false);
      assert.notEqual(p.document.getElementById('error').textContent, '');
      assert.equal(page.w.SecurityNavigationRotation.snapshot().running, false);
      assert.equal(p.held.size, 0);
      page.advance(60000);
      assert.deepEqual(page.clicks, ['对象']);
      assert.equal(page.timers.size, 0);
    },
  );
}

test(
  'stopping while trial injection is pending prevents the not-yet-dispatched click',
  { timeout: 8000 },
  async (t) => {
    const p = await setup(t);
    await p.settle();
    const page = await attachRotationPage(t, p);
    let injections = 0,
      entered,
      release;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const executeScript = p.w.chrome.scripting.executeScript;
    p.w.chrome.scripting.executeScript = async (options) => {
      const result = await executeScript(options);
      if (options.files && ++injections === 2) {
        entered();
        await gate;
      }
      return result;
    };
    const trial = p.api.rotationAction(p.api.rotationTrial, { source: false });
    await ready;
    p.document.getElementById('rotation-stop').click();
    await p.settle();
    release();
    await trial;
    assert.equal(p.api.getRotationVerified(), false);
    assert.match(p.document.getElementById('error').textContent, /试运行已取消/);
    assert.deepEqual(page.clicks, []);
    assert.equal(page.w.SecurityNavigationRotation.snapshot().running, false);
    assert.equal(p.held.size, 0);
  },
);

test('clearing an error before rotation immediately hides the empty alert', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.error(new Error('旧的文档错误'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const action = p.api.rotationAction(() => gate, { source: false });
  await p.settle();
  try {
    assert.equal(p.document.getElementById('error').textContent, '');
    assert.equal(p.document.getElementById('error').hidden, true);
  } finally {
    release();
    await action;
  }
});

test('changing workspace sections does not carry an unrelated error banner', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.api.error(new Error('未识别文档目录'));
  p.document.querySelector('[data-mode="rotation"]').click();
  assert.equal(p.document.getElementById('error').hidden, true);
  assert.equal(p.document.getElementById('error').textContent, '');
});

test('source failures stay in their calibration view instead of a global workspace banner', async (t) => {
  const p = await setup(t, { workspace: true });
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  p.state.sessions = new Map([[session.tabId, session]]);
  await session.connect();
  await p.api.selectSession(session, { view: 'web' });
  session.error = '未识别正文，请点选正文区域';
  p.state.batchOptions.onError(new Error(session.error), session);
  p.api.render();
  assert.equal(p.document.getElementById('error').hidden, true);
  assert.match(p.document.getElementById('recognition-message').textContent, /未识别正文/);
  p.document.querySelector('[data-mode="rotation"]').click();
  assert.equal(p.document.getElementById('error').hidden, true);
  assert.equal(session.error, '未识别正文，请点选正文区域');
});

test('scan is available before choosing a historical rule and performs fresh quick discovery', async (t) => {
  const p = await setup(t, {
    workspace: true,
    savedProfiles: [seed(), { ...seed(), id: 'duplicate' }],
  });
  await p.settle();
  const requests = [];
  const session = {
    tabId: 1,
    io: p.api.getIO(),
    profile: null,
    task: null,
    busy: false,
    getState: () => ({ canPause: false }),
    scanDirectory: async (options) => requests.push(options),
  };
  p.state.sessions = new Map([[1, session]]);
  await p.api.selectSession(session);
  const button = p.document.getElementById('scan');
  assert.equal(button.disabled, false);
  button.click();
  await p.settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].detect, true);
  assert.equal(requests[0].expand, false);
  assert.equal(button.disabled, false);
});

test('a stopped collection explains the failure beside Continue without opening diagnostics', async (t) => {
  const p = await setup(t);
  await p.settle();
  p.state.captureError = '页面定位规则失效或不唯一，请重新校准';
  await p.api.run();
  const message = p.document.getElementById('collection-message');
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /定位规则失效/);
  assert.match(message.textContent, /1 章失败/);
  assert.match(message.textContent, /来源页/);
  message.click();
  assert.equal(p.document.querySelector('[data-view-panel="errors"]').hidden, false);
  assert.match(p.document.getElementById('error-log').textContent, /定位规则失效/);
  p.api.getIO().recover = async () => {
    throw new Error('页面定位规则失效或不唯一，请重新校准');
  };
  await p.api.run();
  assert.equal(p.api.getTask().queue.filter((c) => c.status === 'failed').length, 1);
  p.state.captureError = null;
  p.api.getIO().recover = async () => ({ status: 'ok' });
  await p.api.run();
  assert.equal(p.api.getTask().status, 'finished');
  assert.equal(p.api.getTask().queue.filter((c) => c.status === 'captured').length, 2);
  assert.equal(message.hidden, true);
});

test('viewing another saved archive never borrows the connected source pause reason', async (t) => {
  const saved = createTask(
    profiles.validateProfile({
      ...seed(),
      id: 'other',
      entry: 'https://other.test/docs',
      origin: 'https://other.test',
    }),
    'Other',
  );
  saved.status = 'finished';
  const p = await setup(t, { savedTasks: [saved] });
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.initialize();
  await p.api.selectSession(session, { view: 'web' });
  session.error = '另一个来源的网络错误';
  await p.api.openTask(saved);
  assert.equal(p.api.getTask().taskId, saved.taskId);
  assert.equal(p.document.getElementById('collection-message').hidden, true);
  assert.doesNotMatch(p.document.getElementById('error-log').textContent, /另一个来源/);
});

async function failedVerifiedPanelScan(t) {
  const p = await setup(t);
  await p.settle();
  const session = connectedPanelSession(p);
  t.after(() => session.dispose());
  await session.connect();
  await session.initialize();
  await session.validate(() => true);
  const first = session.task.queue[0];
  first.status = 'captured';
  session.task.pages[first.key] = {
    text: 'Kept chapter body',
    hash: 'kept-hash',
    capturedAt: 'kept-time',
  };
  await p.w.saveTask(session.task);
  const before = structuredClone(session.task);
  await p.api.selectSession(session, { view: 'web' });
  session.io.discover = async () => ({
    status: 'error',
    error: '目录定位匹配多个普通区域，请重新校准',
  });
  p.document.getElementById('scan').click();
  await p.settle();
  return { p, session, before };
}

test('Continue and Retry recheck the verified original task after a failed rescan before collecting any chapter', async (t) => {
  const { p, session, before } = await failedVerifiedPanelScan(t);
  const start = p.document.getElementById('start'),
    retry = p.document.getElementById('retry');
  assert.equal(start.disabled, false);
  assert.equal(retry.disabled, false);
  assert.match(start.textContent, /重新检查.*继续/);
  assert.equal(session.initialized, false);
  const checked = [];
  session.io.recover = async () => {
    checked.push('recover');
    return { status: 'ok' };
  };
  session.io.prepare = async () => {
    checked.push('prepare');
    throw new Error('目录仍有歧义');
  };
  start.click();
  await p.settle();
  assert.deepEqual(checked, ['recover', 'prepare']);
  assert.deepEqual(session.task.queue, before.queue);
  assert.deepEqual(session.task.pages, before.pages);
  assert.equal(session.initialized, false);
  assert.equal(start.disabled, false);
  assert.equal(retry.disabled, false);
  assert.equal(p.state.captured.length, 0);
  session.io.prepare = async () => {
    checked.push('prepare');
    return { status: 'ok', changed: false };
  };
  retry.click();
  await p.settle();
  assert.deepEqual(checked, ['recover', 'prepare', 'recover', 'prepare']);
  assert.equal(session.task.taskId, before.taskId);
  assert.deepEqual(session.task.pages[before.queue[0].key], before.pages[before.queue[0].key]);
  assert.equal(session.task.status, 'finished');
  assert.equal(p.state.captured.length, 1);
});

test('editing a failed rescan draft disables Continue and Retry even after task identity is cloned', async (t) => {
  const { p, session, before } = await failedVerifiedPanelScan(t);
  session.draft = structuredClone(session.draft);
  session.task = structuredClone(session.task);
  await p.api.selectSession(session, { view: 'web' });
  p.document.getElementById('toc-selector').value = '#edited-directory';
  p.document.getElementById('toc-selector').dispatchEvent(new p.w.Event('input'));
  const start = p.document.getElementById('start'),
    retry = p.document.getElementById('retry');
  assert.equal(start.disabled, true);
  assert.equal(retry.disabled, true);
  start.click();
  retry.click();
  await p.settle();
  assert.equal(p.state.captured.length, 0);
  assert.deepEqual(p.disk.get(before.taskId), before);
  assert.equal(p.document.getElementById('scan').disabled, false);
  assert.equal(p.document.getElementById('open-calibration').disabled, false);
});

for (const workspace of [false, true])
  for (const accept of [false, true])
    test(`explicit retry can repair old empty examples with consent (workspace=${workspace}, accept=${accept})`, async (t) => {
      const p = await setup(t, { workspace });
      await p.settle();
      if (workspace) {
        const session = connectedPanelSession(p);
        t.after(() => session.dispose());
        p.state.sessions = new Map([[session.tabId, session]]);
        session.onChange = (_state, value) => p.state.batchOptions.onChange(value);
        await session.connect();
        await session.initialize();
        await p.api.selectSession(session, { view: 'web' });
      }
      await (workspace ? p.api.startSelected() : p.api.run());
      const saved = p.api.getTask();
      const key = saved.queue[0].key;
      const old = {
        ...saved.pages[key],
        text: '请求样例',
        html: '<div><div><span></span>请求样例</div></div>',
      };
      saved.pages[key] = old;
      p.disk.set(saved.taskId, structuredClone(saved));
      const other = JSON.stringify(saved.pages[saved.queue[1].key]);
      p.state.captured.length = 0;
      const prompts = [];
      p.w.confirm = (message) => {
        prompts.push(message);
        return accept;
      };
      await (workspace ? p.api.startSelected({ retry: true }) : p.api.run(true));
      const result = p.disk.get(saved.taskId);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /样例缺失/);
      assert.equal(p.state.captured.length, accept ? 1 : 0);
      assert.equal(JSON.stringify(result.pages[saved.queue[1].key]), other);
      assert.equal(result.pages[key].text, accept ? 'body A' : '请求样例');
    });
