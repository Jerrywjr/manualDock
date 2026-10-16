import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ruleSignature, validateProfile } from '../extension/profiles.js';
import { createTask } from '../extension/engine.js';
import * as store from '../extension/task-store.js';
let SourceSession;
try {
  ({ SourceSession } = await import('../extension/session.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const flush = async () => {
  for (let n = 0; n < 6; n++) await new Promise((resolve) => setImmediate(resolve));
};
function setup(t) {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const held = new Set();
  const locks = {
    request: async (name, options, action) => {
      if (held.has(name)) return action(null);
      held.add(name);
      try {
        return await action({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  const sessions = [];
  t.after(() => sessions.forEach((session) => session.dispose()));
  function session(
    tabId,
    { profileId = 'profile-' + tabId, origin = 'https://manual' + tabId + '.test', purpose } = {},
  ) {
    assert.equal(typeof SourceSession, 'function', 'direct source sessions must be implemented');
    const profile = validateProfile({
      schemaVersion: 1,
      id: profileId,
      revision: 1,
      adapterId: 'generic',
      name: 'Manual ' + tabId,
      entry: origin + '/docs',
      pathPrefix: '/',
      tocSelector: 'nav',
      contentSelector: 'main',
      hashMode: 'none',
      queryKeys: [],
      navigation: 'links',
      samples: [],
    });
    const chapters = ['a', 'b', 'c'].map((title) => ({
      key: 'url:' + origin + '/' + title,
      url: origin + '/' + title,
      title,
    }));
    const calls = {
      scans: [],
      verify: 0,
      captured: [],
      timers: [],
      errors: [],
      current: 0,
      recover: 0,
    };
    const io = {
      tab: async () => ({ id: tabId, url: profile.entry, title: profile.name }),
      detect: async () => ({ profile, warnings: [] }),
      discover: async (_profile, options) => {
        calls.scans.push(options);
        return { items: chapters, warnings: [], diagnostics: {} };
      },
      verifySamples: async (_profile, { shouldContinue }) => {
        calls.verify++;
        if (calls.verifyGate) await calls.verifyGate;
        if (!shouldContinue()) throw Object.assign(new Error('采集已暂停'), { code: 'CANCELLED' });
        return { verified: true, previews: [] };
      },
      capture: async (chapter) => {
        calls.captured.push(chapter.key);
        if (calls.captureGate) await calls.captureGate;
        if (calls.networkError)
          throw Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' });
        return { status: 'ok', text: 'Body ' + chapter.url, navigationProof: { verified: true } };
      },
      recover: async () => {
        calls.recover++;
        return { status: 'ok' };
      },
      current: async () => {
        calls.current++;
        return { status: 'ok', chapter: chapters[1] };
      },
    };
    const value = new SourceSession({
      tabId,
      purpose,
      io,
      locks,
      onError: (error) => calls.errors.push(error.message),
      clockOptions: {
        setTimer: (callback, delay) => {
          calls.timers.push({ callback, delay });
          return calls.timers.length;
        },
        clearTimer: () => {},
      },
    });
    sessions.push(value);
    return { value, calls, io, profile, chapters };
  }
  return { session, held };
}

test('each source initializes its own saved queue without navigating through two samples', async (t) => {
  const p = setup(t),
    a = p.session(1),
    b = p.session(2);
  await Promise.all([a.value.initialize(), b.value.initialize()]);
  assert.equal(a.value.getState().initialized, true);
  assert.notEqual(a.value.getState().taskId, b.value.getState().taskId);
  assert.deepEqual(a.calls.scans, [{ expand: false }]);
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.captured.length, 0);
  assert.equal((await store.listTasks()).length, 2);
});

test('different sources import concurrently and reuse a persisted successful rule validation', async (t) => {
  const p = setup(t),
    a = p.session(1),
    b = p.session(2);
  await Promise.all([a.value.initialize(), b.value.initialize()]);
  let release;
  a.calls.captureGate = new Promise((resolve) => {
    release = resolve;
  });
  const running = a.value.start();
  await flush();
  await b.value.start();
  assert.equal(b.value.getState().progress.captured, 3);
  release();
  await running;
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.calls.verify, 1);
  assert.equal(b.calls.verify, 1);
  await a.value.start();
  assert.equal(a.calls.verify, 1);
  assert.equal(a.calls.captured.length, 3);
  assert.equal((await store.loadTask(a.value.task.taskId)).validation.signature.length > 0, true);
});

test('a second session cannot mutate a task while another source owns its task lock', async (t) => {
  const p = setup(t),
    a = p.session(1),
    b = p.session(2, { profileId: 'profile-1', origin: 'https://manual1.test' });
  await a.value.initialize();
  await b.value.initialize();
  let release;
  a.calls.captureGate = new Promise((resolve) => {
    release = resolve;
  });
  const running = a.value.start();
  await flush();
  await b.value.start();
  assert.equal(b.calls.captured.length, 0);
  assert.match(b.value.getState().error, /正在|另一个/);
  release();
  await running;
  assert.equal(
    (await store.loadTask(a.value.task.taskId)).queue.filter(
      (chapter) => chapter.status === 'captured',
    ).length,
    3,
  );
});

test('pause during validation prevents a later capture and disables automatic recovery', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  let release;
  a.calls.verifyGate = new Promise((resolve) => {
    release = resolve;
  });
  const running = a.value.start();
  await flush();
  await a.value.pause();
  release();
  await running;
  assert.equal(a.calls.captured.length, 0);
  assert.equal(a.value.getState().status, 'paused');
  assert.equal((await store.loadTask(a.value.task.taskId)).autoRecovery.enabled, false);
});

test('transient network failure schedules a persisted retry and resumes only unfinished chapters', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  assert.equal(a.value.getState().status, 'retry_wait');
  assert.equal(a.calls.timers.length, 1);
  assert.ok(a.calls.timers[0].delay > 4000 && a.calls.timers[0].delay <= 5000);
  const saved = await store.loadTask(a.value.task.taskId);
  assert.equal(saved.autoRecovery.sourceTabId, 1);
  a.calls.networkError = false;
  await a.calls.timers[0].callback();
  assert.equal(a.calls.recover, 1);
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.calls.verify, 1);
  assert.equal(a.value.getState().canPause, false);
});

test('capture current records one proven chapter without two-sample verification or a full scan', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  await a.value.captureCurrent();
  assert.equal(a.calls.current, 1);
  assert.equal(a.calls.verify, 0);
  assert.deepEqual(a.calls.captured, ['url:https://manual1.test/b']);
  const saved = await store.loadTask(a.value.task.taskId);
  assert.equal(saved.queue.length, 3);
  assert.equal(Object.keys(saved.pages).length, 1);
  assert.equal(saved.queue.find((chapter) => chapter.title === 'a').status, 'pending');
});

test('a second transient failure schedules another bounded retry instead of dropping or spinning the timer', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  await a.calls.timers[0].callback();
  assert.equal(a.calls.timers.length, 2);
  assert.ok(a.calls.timers[1].delay > 14000);
  await a.value.pause();
});

test('adopting calibrated state invalidates old validation and refuses replacement while running', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  const task = structuredClone(a.value.task),
    profile = structuredClone(a.value.profile);
  task.product = 'Renamed';
  profile.contentSelector = '#article';
  task.validation = { signature: 'old rule' };
  assert.equal(typeof a.value.adopt, 'function');
  a.value.adopt(task, profile);
  assert.equal(a.value.getState().product, 'Renamed');
  assert.equal(a.value.task.validation, undefined);
  a.value.busy = true;
  assert.throws(() => a.value.adopt(task, profile), /采集|运行|暂停/);
});

test('explicit retry resets failed chapters while retaining captured pages', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  await a.value.captureCurrent();
  a.value.task.queue[0].status = 'failed';
  a.value.task.queue[0].recovery = { retryable: false };
  await store.saveTask(a.value.task);
  await a.value.start({ retry: true });
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.calls.captured.filter((key) => key.endsWith('/b')).length, 1);
});

test('a deleted task cannot be recreated by a stale source and an explicit restore refreshes it', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  const saved = await store.loadTask(a.value.task.taskId);
  await store.deleteTask(saved.taskId);
  await a.value.refresh();
  assert.equal(a.value.getState().canStart, false);
  await a.value.start();
  assert.equal(a.calls.captured.length, 0);
  assert.equal(await store.loadTask(saved.taskId), null);
  saved.storageRevision = 0;
  await store.restoreWholeTask(saved);
  await a.value.refresh();
  assert.equal(a.value.getState().canStart, true);
});

test('a busy source lock stops automatic retry locally without an immediate retry loop', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  p.held.add('source-tab:1');
  await a.calls.timers[0].callback();
  assert.equal(a.calls.timers.length, 1);
  assert.equal(a.value.getState().canPause, false);
});

test('full import expands a previously incomplete directory once and current-only capture does not', async (t) => {
  const p = setup(t),
    a = p.session(1);
  let expanded = 0;
  a.io.discover = async (_profile, options) => {
    if (options.expand) expanded++;
    return {
      items: options.expand ? a.chapters : a.chapters.slice(0, 1),
      warnings: [],
      diagnostics: { pendingBranches: options.expand ? 0 : 1 },
    };
  };
  await a.value.initialize();
  await a.value.captureCurrent();
  assert.equal(expanded, 0);
  await a.value.start();
  assert.equal(expanded, 1);
  assert.equal(a.value.getState().progress.captured, 3);
  await a.value.start();
  assert.equal(expanded, 1);
});

test('navigation rotation blocks both whole-manual and current-chapter capture before verification', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.io.isRotating = async () => true;
  await a.value.start();
  await a.value.captureCurrent();
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.current, 0);
  assert.equal(a.calls.captured.length, 0);
  assert.match(a.value.getState().error, /轮换/);
});

test('recording the current chapter preserves failure states of unrelated chapters', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.value.task.queue[0].status = 'failed';
  a.value.task.queue[0].recovery = { retryable: true };
  await store.saveTask(a.value.task);
  await a.value.captureCurrent();
  assert.equal(a.value.task.queue[0].status, 'failed');
});

test('automatic recovery navigates away from a browser error before checking injected rotation state', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  const order = [];
  let recovered = false;
  a.io.recover = async () => {
    order.push('recover');
    recovered = true;
    return { status: 'ok' };
  };
  a.io.isRotating = async () => {
    order.push('rotation');
    if (!recovered) throw new Error('Frame with ID 0 is showing error page');
    return false;
  };
  a.calls.networkError = false;
  await a.calls.timers[0].callback();
  assert.deepEqual(order, ['rotation', 'recover', 'rotation']);
  assert.equal(a.value.getState().progress.captured, 3);
});

for (const kind of ['browser-error', 'same-origin-login'])
  test(`reopening ${kind} restores the bound retry task without detecting or scanning that page`, async (t) => {
    const p = setup(t),
      a = p.session(1);
    await a.value.initialize();
    a.calls.networkError = true;
    await a.value.start();
    const taskId = a.value.task.taskId;
    assert.equal(await store.getSetting('recovery-tab:1'), taskId);
    a.value.dispose();
    const reopened = p.session(1);
    reopened.io.tab = async () =>
      kind === 'browser-error'
        ? { id: 1, url: 'chrome-error://chromewebdata/', pendingUrl: 'https://manual1.test/a' }
        : { id: 1, url: 'https://manual1.test/login' };
    reopened.io.detect = async () => {
      throw new Error('must not detect a recovery page');
    };
    reopened.io.discover = async () => {
      throw new Error('must not scan a recovery page');
    };
    await reopened.value.initialize();
    assert.equal(reopened.value.getState().initialized, true);
    assert.equal(reopened.value.task.taskId, taskId);
    assert.equal(reopened.calls.recover, 0);
    assert.equal(reopened.calls.timers.length, 1);
  });

test('a recovery binding rejects a foreign or unproven browser-error pending address', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  a.value.dispose();
  for (const pendingUrl of [
    'https://foreign.test/a',
    'https://manual1.test/a?token=secret',
    undefined,
  ]) {
    const reopened = p.session(1);
    reopened.io.tab = async () => ({ id: 1, url: 'chrome-error://chromewebdata/', pendingUrl });
    reopened.io.detect = async () => {
      throw new Error('unexpected detection');
    };
    await reopened.value.initialize();
    assert.equal(reopened.value.getState().initialized, false);
    assert.equal(reopened.calls.timers.length, 0);
    assert.equal(reopened.calls.captured.length, 0);
  }
});

test('connecting a page only reads its address and creates no collection task', async (t) => {
  const p = setup(t),
    a = p.session(1);
  assert.equal(typeof a.value.connect, 'function');
  await a.value.connect();
  assert.equal(a.value.getState().status, 'connected');
  assert.equal(a.value.getState().canStart, true);
  assert.equal(a.value.task, null);
  assert.equal(a.calls.scans.length, 0);
  assert.equal(a.calls.captured.length, 0);
  assert.equal(a.calls.timers.length, 0);
  assert.equal((await store.listTasks()).length, 0);
  await a.value.start();
  assert.equal(a.value.getState().progress.captured, 3);
});

async function saveIncomplete(session, missing) {
  const profile = validateProfile({ ...session.profile, [missing]: '' });
  const task = createTask(profile, 'Saved manual', 'saved-version');
  const chapter = { ...session.chapters[0], status: 'captured' };
  task.queue = [chapter];
  task.pages[chapter.key] = {
    status: 'ok',
    url: chapter.url,
    text: 'Saved original body',
    hash: 'saved-hash',
  };
  await store.saveProfile(profile);
  await store.saveTask(task, chapter.key);
  return { profile, task: await store.loadTask(task.taskId) };
}

for (const missing of ['tocSelector', 'contentSelector'])
  test(`a saved profile missing ${missing} is detected again without replacing its archived pages`, async (t) => {
    const p = setup(t),
      a = p.session(1);
    const old = await saveIncomplete(a, missing);
    let detections = 0;
    a.io.detect = async () => {
      detections++;
      return { profile: a.profile, warnings: [] };
    };
    await a.value.initialize();
    assert.equal(detections, 1, 'a saved incomplete profile must not bypass detection');
    assert.equal(a.value.initialized, true);
    assert.notEqual(a.value.profile.id, old.profile.id);
    assert.notEqual(a.value.task.taskId, old.task.taskId);
    assert.equal(a.value.task.product, old.task.product);
    assert.equal(a.value.task.version, old.task.version);
    assert.deepEqual(await store.loadTask(old.task.taskId), old.task);
    assert.deepEqual(
      (await store.loadProfiles()).find((profile) => profile.id === old.profile.id),
      old.profile,
    );
    assert.equal((await store.listTasks()).length, 2);
    assert.equal(a.calls.captured.length, 0);
    assert.equal(a.calls.timers.length, 0);
  });

test('fresh complete detection can replace the active incomplete rule while preserving its archive', async (t) => {
  const p = setup(t),
    a = p.session(1);
  a.profile.tocSelector = '#hand-picked-tree';
  const old = await saveIncomplete(a, 'contentSelector');
  let detections = 0;
  a.io.detect = async () => {
    detections++;
    return { profile: { ...a.profile, tocSelector: 'nav', contentSelector: 'main' }, warnings: [] };
  };
  await a.value.initialize();
  assert.equal(detections, 1);
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.profile.tocSelector, 'nav');
  assert.notEqual(a.value.profile.id, old.profile.id);
  assert.deepEqual(await store.loadTask(old.task.taskId), old.task);
  assert.equal((await store.listTasks()).length, 2);
  assert.equal(a.calls.scans.length, 1);
  assert.equal(a.calls.timers.length, 0);
});

test('still-missing regions stop after one detection without saving another broken profile or scheduling retries', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const old = await saveIncomplete(a, 'tocSelector');
  let detections = 0;
  a.io.detect = async () => {
    detections++;
    return { profile: old.profile, warnings: ['未自动识别目录'] };
  };
  await a.value.initialize();
  assert.equal(detections, 1);
  assert.equal(a.value.initialized, false);
  assert.match(a.value.error, /目录|正文|点选/);
  assert.equal(a.calls.scans.length, 0);
  assert.equal(a.calls.timers.length, 0);
  assert.deepEqual(await store.loadTask(old.task.taskId), old.task);
  assert.equal((await store.loadProfiles()).length, 1);
  assert.equal((await store.listTasks()).length, 1);
});

for (const count of [0, 1])
  test(`complete saved manual regions are reused with ${count} chapter without repeated detection`, async (t) => {
    const p = setup(t),
      a = p.session(1);
    await store.saveProfile(a.profile);
    let detections = 0,
      scans = 0;
    a.io.detect = async () => {
      detections++;
      throw new Error('must not replace a complete saved rule');
    };
    a.io.discover = async () => {
      scans++;
      return { items: a.chapters.slice(0, count), warnings: [], diagnostics: {} };
    };
    await a.value.initialize();
    await a.value.initialize();
    assert.equal(a.value.initialized, true);
    assert.equal(a.value.task.queue.length, count);
    assert.equal(detections, 0);
    assert.equal(scans, 1);
    assert.equal(a.calls.timers.length, 0);
  });

test('ambiguous historical rules trigger fresh detection without changing the stored rules', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await store.saveProfile(a.profile);
  await store.saveProfile({ ...a.profile, id: 'second-profile', contentSelector: '' });
  let detections = 0;
  a.io.detect = async () => {
    detections++;
    return { profile: a.profile, warnings: [] };
  };
  await a.value.initialize();
  assert.equal(a.value.initialized, true);
  assert.notEqual(a.value.profile.id, a.profile.id);
  assert.equal(detections, 1);
  assert.equal(a.calls.scans.length, 1);
  assert.equal((await store.listTasks()).length, 1);
  assert.deepEqual(
    (await store.loadProfiles()).find((p) => p.id === a.profile.id),
    a.profile,
  );
});

test('a source has a fixed purpose and existing callers default to document collection', async (t) => {
  const p = setup(t),
    a = p.session(1);
  assert.equal(a.value.getState().purpose, 'document');
  assert.throws(() => {
    a.value.purpose = 'rotation';
  }, /read only|readonly|Cannot assign/i);
  assert.throws(() => p.session(2, { purpose: 'unknown' }), /用途/);
  await a.value.connect();
  assert.equal(a.value.getState().canStart, true);
});

test('a rotation source connects but rejects every collection entry point without scanning or saving', async (t) => {
  const p = setup(t),
    a = p.session(1, { purpose: 'rotation' });
  await a.value.connect();
  assert.equal(a.value.getState().purpose, 'rotation');
  assert.equal(a.value.getState().status, 'connected');
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.value.getState().canPause, false);
  await assert.rejects(a.value.initialize(), /轮换.*独立标签页/);
  await assert.rejects(a.value.start(), /轮换.*独立标签页/);
  await assert.rejects(a.value.captureCurrent(), /轮换.*独立标签页/);
  await assert.rejects(
    a.value.validate(() => true),
    /轮换.*独立标签页/,
  );
  await assert.rejects(a.value.reload(), /轮换.*独立标签页/);
  await assert.rejects(a.value.savedRecovery({}), /轮换.*独立标签页/);
  assert.throws(() => a.value.engineForTask(), /轮换.*独立标签页/);
  assert.throws(() => a.value.adopt(createTask(a.profile), a.profile), /轮换.*独立标签页/);
  assert.equal(a.value.task, null);
  assert.equal(a.value.initialized, false);
  assert.equal(a.calls.scans.length, 0);
  assert.equal(a.calls.current, 0);
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.captured.length, 0);
  assert.equal(a.calls.timers.length, 0);
  assert.equal((await store.listTasks()).length, 0);
  assert.equal((await store.loadProfiles()).length, 0);
  await a.value.close();
  assert.equal(a.value.getState().status, 'closed');
  assert.equal(a.value.getState().canPause, false);
});

test('rotation state cannot enable collection or task recovery even if document state is assigned accidentally', async (t) => {
  const p = setup(t),
    a = p.session(1, { purpose: 'rotation' });
  a.value.task = createTask(a.profile);
  a.value.task.autoRecovery = { enabled: true, sourceTabId: 1, nextAttemptAt: Date.now() + 1000 };
  a.value.profile = a.profile;
  a.value.initialized = true;
  a.value.busy = true;
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.value.getState().canPause, false);
  a.value.retryClock.refresh();
  assert.equal(a.calls.timers.length, 0);
  a.value.busy = false;
  await a.value.pause();
  await a.value.refresh();
  assert.equal(a.value.deleted, false);
  assert.equal((await store.listTasks()).length, 0);
});

test('failed initial recognition stays needs_calibration and an explicit recognition retry can recover', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.connect();
  a.io.detect = async () => ({ profile: { ...a.profile, contentSelector: '' }, warnings: [] });
  await a.value.start();
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.calls.captured.length, 0);
  assert.equal((await store.listTasks()).length, 0);
  a.io.detect = async () => ({ profile: a.profile, warnings: [] });
  await a.value.initialize();
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.getState().status, 'ready');
  assert.equal(a.value.getState().canStart, true);
});

test('failed recognition takes precedence over a saved paused task status', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const task = createTask(a.profile);
  task.status = 'paused';
  await store.saveProfile(a.profile);
  await store.saveTask(task);
  a.io.discover = async () => ({ status: 'error', error: '目录读取失败，请校准' });
  await a.value.initialize();
  assert.equal(a.value.task.status, 'paused');
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
});

test('an empty discovered directory is saved as needing calibration and never becomes paused zero chapters', async (t) => {
  const p = setup(t),
    a = p.session(1);
  a.io.discover = async (_profile, options) => {
    a.calls.scans.push(options);
    return { items: [], diagnostics: {}, warnings: [] };
  };
  await a.value.initialize();
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.value.getState().canCaptureCurrent, true);
  assert.equal((await store.loadTask(a.value.task.taskId)).status, 'needs_calibration');
  await a.value.start();
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.deepEqual(a.calls.scans, [{ expand: false }]);
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.captured.length, 0);
  assert.equal(a.calls.timers.length, 0);
});

for (const expandedCount of [0, 3])
  test(`an empty directory with pending branches permits one explicit expansion producing ${expandedCount} chapters`, async (t) => {
    const p = setup(t),
      a = p.session(1);
    a.io.discover = async (_profile, options) => {
      a.calls.scans.push(options);
      return {
        items: options.expand ? a.chapters.slice(0, expandedCount) : [],
        diagnostics: { pendingBranches: options.expand ? 0 : 1 },
        warnings: [],
      };
    };
    await a.value.initialize();
    assert.equal(a.value.getState().status, 'needs_calibration');
    assert.equal(a.value.getState().canStart, true);
    await a.value.start();
    assert.deepEqual(a.calls.scans, [{ expand: false }, { expand: true }]);
    assert.equal(a.value.getState().status, expandedCount ? 'finished' : 'needs_calibration');
    assert.equal(
      (await store.loadTask(a.value.task.taskId)).status,
      expandedCount ? 'finished' : 'needs_calibration',
    );
    assert.equal(a.calls.verify, expandedCount ? 1 : 0);
    assert.equal(a.calls.captured.length, expandedCount);
    assert.equal(a.calls.timers.length, 0);
    if (!expandedCount) assert.equal(a.value.getState().canStart, false);
  });

test('adopting an empty scanned task requires directory calibration while preserving proven current-chapter capture', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const task = createTask(a.profile);
  await store.saveTask(task);
  a.value.adopt(task, a.profile);
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.value.getState().canCaptureCurrent, true);
  await a.value.captureCurrent();
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.current, 1);
  assert.equal(a.value.getState().progress.captured, 1);
});

function verifiedDefaultTask(a) {
  const profile = validateProfile({
    ...a.profile,
    contentSelector: '',
    samples: a.chapters.slice(0, 2),
  });
  const task = createTask(profile, 'Verified default extraction');
  task.queue = a.chapters.map((chapter) => ({ ...chapter, status: 'pending' }));
  task.validation = { signature: ruleSignature(profile), verifiedAt: new Date().toISOString() };
  return { profile, task };
}

test('a saved default extraction rule with matching two-sample validation is reused without replacement', async (t) => {
  const p = setup(t),
    a = p.session(1),
    saved = verifiedDefaultTask(a);
  await store.saveProfile(saved.profile);
  await store.saveTask(saved.task);
  let detections = 0;
  a.io.detect = async () => {
    detections++;
    throw new Error('must not replace verified default extraction');
  };
  await a.value.initialize();
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.task.taskId, saved.task.taskId);
  assert.equal(a.value.profile.contentSelector, '');
  assert.equal(detections, 0);
  await a.value.start();
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.calls.verify, 0);
  assert.equal((await store.listTasks()).length, 1);
});

for (const invalid of ['stale-signature', 'duplicate-sample'])
  test(`a default extraction rule with ${invalid} is not trusted as previously verified`, async (t) => {
    const p = setup(t),
      a = p.session(1),
      saved = verifiedDefaultTask(a);
    if (invalid === 'stale-signature') saved.task.validation.signature = 'old';
    else saved.profile.samples = [a.chapters[0], a.chapters[0]];
    saved.task.profile = saved.profile;
    await store.saveProfile(saved.profile);
    await store.saveTask(saved.task);
    a.io.detect = async () => ({ profile: saved.profile, warnings: [] });
    await a.value.initialize();
    assert.equal(a.value.initialized, false);
    assert.equal(a.value.getState().status, 'needs_calibration');
    assert.equal(a.calls.captured.length, 0);
    assert.equal((await store.listTasks()).length, 1);
  });

test('adopt uses the same verified default-extraction evidence as reopening a saved source', async (t) => {
  const p = setup(t),
    a = p.session(1),
    saved = verifiedDefaultTask(a);
  a.value.adopt(saved.task, saved.profile);
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.getState().canStart, true);
  const unverified = structuredClone(saved.task);
  delete unverified.validation;
  a.value.adopt(unverified, saved.profile);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
});

test('explicit collection after deleting an archive creates a fresh identity and retains the old tombstone', async (t) => {
  const p = setup(t),
    stale = p.session(1);
  await stale.value.initialize();
  await stale.value.captureCurrent();
  const deleted = await store.loadTask(stale.value.task.taskId);
  await store.deleteTask(deleted.taskId);
  assert.equal(
    (await store.loadProfiles()).length,
    1,
    'deleting an archive retains its calibration',
  );
  const fresh = p.session(2, { profileId: stale.profile.id, origin: stale.profile.origin });
  fresh.io.discover = async () => ({
    items: Array.from({ length: 447 }, (_, index) => ({
      url: stale.profile.origin + '/chapter-' + index,
      title: 'Chapter ' + index,
    })),
    warnings: [],
    diagnostics: {},
  });
  await fresh.value.initialize();
  assert.equal(fresh.value.initialized, true, fresh.value.error);
  assert.notEqual(fresh.value.task.taskId, deleted.taskId);
  assert.notEqual(fresh.value.profile.id, deleted.profile.id);
  assert.equal(fresh.value.task.queue.length, 447);
  assert.equal(Object.keys(fresh.value.task.pages).length, 0);
  await fresh.value.start();
  assert.equal(fresh.value.getState().progress.captured, 447);
  assert.equal((await store.loadTask(fresh.value.task.taskId)).queue.length, 447);
  assert.equal(await store.loadTask(deleted.taskId), null);
  assert.equal(await store.getSetting('deleted-task:' + deleted.taskId), true);
  await assert.rejects(store.saveTask(deleted), /任务已删除/);
  await stale.value.start();
  assert.match(stale.value.error, /任务已删除/);
  assert.equal(stale.calls.captured.length, 1, 'the stale source must not capture again');
});

test('refreshing a never-saved calibrated draft does not invent a deletion or block its first capture', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const draft = createTask(a.profile, 'Fresh unsaved draft');
  draft.queue = a.chapters.map((chapter) => ({ ...chapter, status: 'pending' }));
  a.value.adopt(draft, a.profile);
  await a.value.refresh();
  assert.equal(a.value.deleted, false);
  assert.equal(a.value.getState().canStart, true);
  assert.doesNotMatch(a.value.error, /删除/);
  assert.equal(await store.loadTask(draft.taskId), null);
  await a.value.start();
  assert.equal(a.value.getState().progress.captured, 3);
});

test('a draft reusing a genuinely deleted task identity is still marked deleted on refresh', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const saved = createTask(a.profile, 'Deleted identity');
  await store.saveTask(saved);
  await store.deleteTask(saved.taskId);
  const staleDraft = createTask(a.profile, 'Deleted identity');
  staleDraft.queue = a.chapters.map((chapter) => ({ ...chapter, status: 'pending' }));
  a.value.adopt(staleDraft, a.profile);
  await a.value.refresh();
  assert.equal(a.value.deleted, true);
  assert.equal(a.value.getState().canStart, false);
  assert.match(a.value.error, /删除/);
});

test('directory scanning reuses matching calibration and complete saved pages without capturing samples', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  await a.value.captureCurrent();
  const before = await store.loadTask(a.value.task.taskId);
  a.io.detect = async () => ({
    profile: { ...a.profile, id: 'new-detection-id' },
    warnings: ['Detected'],
  });
  a.io.discover = async (_profile, options) => {
    a.calls.scans.push(options);
    return {
      items: [...a.chapters, { title: 'd', url: a.profile.origin + '/d' }],
      diagnostics: {},
      warnings: [],
    };
  };
  const result = await a.value.scanDirectory({ detect: true, expand: true });
  assert.equal(result.task.taskId, before.taskId);
  assert.equal(result.task.queue.length, 4);
  assert.deepEqual(result.task.pages, before.pages);
  assert.equal(result.profile.id, before.profile.id);
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.captured.length, 1);
  assert.deepEqual(a.calls.scans.at(-1), { expand: true });
  assert.equal(a.value.initialized, true);
  assert.deepEqual((await store.loadTask(before.taskId)).pages, before.pages);
});

test('a scanning source holds only its own locks and pause prevents its pending discovery from being committed', async (t) => {
  const p = setup(t),
    a = p.session(1),
    b = p.session(2);
  await a.value.initialize();
  const before = await store.loadTask(a.value.task.taskId);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    ready = new Promise((resolve) => (entered = resolve));
  a.io.discover = async () => {
    entered();
    await gate;
    return { items: [{ title: 'new', url: a.profile.origin + '/new' }] };
  };
  const scanning = a.value.scanDirectory({ profile: a.profile, expand: true });
  const rejected = assert.rejects(scanning, /暂停|取消/);
  await ready;
  assert.equal(a.value.getState().status, 'scanning');
  assert.equal(a.value.operation, 'scanning');
  assert.ok(p.held.has('source-tab:1'));
  await a.value.refresh();
  assert.throws(() => a.value.adopt(before, a.profile), /采集|运行|暂停/);
  await b.value.connect();
  await b.value.start();
  assert.equal(b.value.getState().progress.captured, 3);
  assert.equal(a.value.getState().status, 'scanning');
  await a.value.pause();
  release();
  await rejected;
  assert.equal(a.value.busy, false);
  assert.deepEqual(await store.loadTask(before.taskId), before);
  assert.equal(a.calls.captured.length, 0);
  assert.equal(a.calls.verify, 0);
});

test('a failed directory scan preserves old saved bodies and exposes a separate calibration draft', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  await a.value.captureCurrent();
  const before = await store.loadTask(a.value.task.taskId),
    oldTask = a.value.task;
  a.io.discover = async () => ({ status: 'error', error: '目录读取失败，请校准' });
  await assert.rejects(a.value.scanDirectory({ profile: a.profile }), /目录读取失败/);
  assert.equal(a.value.task, oldTask);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canStart, false);
  assert.equal(a.value.draft.profile.id, a.profile.id);
  assert.deepEqual(await store.loadTask(before.taskId), before);
});

test('explicit directory scan creates a new identity after archive deletion and honors edited metadata', async (t) => {
  const p = setup(t),
    a = p.session(1);
  const old = createTask(a.profile, 'Edited product', 'v2');
  await store.saveProfile(a.profile);
  await store.saveTask(old);
  await store.deleteTask(old.taskId);
  const result = await a.value.scanDirectory({
    profile: a.profile,
    product: 'Edited product',
    version: 'v2',
    expand: false,
  });
  assert.notEqual(result.task.taskId, old.taskId);
  assert.notEqual(result.profile.id, old.profile.id);
  assert.equal(result.task.product, 'Edited product');
  assert.equal(result.task.version, 'v2');
  assert.equal(result.task.queue.length, 3);
  assert.equal(await store.getSetting('deleted-task:' + old.taskId), true);
  assert.equal(await store.loadTask(old.taskId), null);
  assert.equal(a.calls.verify, 0);
  assert.equal(a.calls.captured.length, 0);
});

test('failed first detection retains its draft without creating a ready task or invoking discovery', async (t) => {
  const p = setup(t),
    a = p.session(1);
  a.io.detect = async () => ({
    profile: { ...a.profile, tocSelector: '' },
    warnings: ['No table of contents'],
  });
  await assert.rejects(a.value.scanDirectory({ detect: true }), /目录/);
  assert.equal(a.value.task, null);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.draft.profile.tocSelector, '');
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.calls.scans.length, 0);
  assert.equal((await store.listTasks()).length, 0);
});

test('pause while a scan checkpoint is waiting aborts its uncommitted directory update', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  const before = await store.loadTask(a.value.task.taskId);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    ready = new Promise((resolve) => (entered = resolve));
  a.value.store = {
    ...store,
    saveTask: async (...args) => {
      entered();
      await gate;
      return store.saveTask(...args);
    },
  };
  a.io.discover = async () => ({ items: [{ title: 'new', url: a.profile.origin + '/new' }] });
  const scanning = a.value.scanDirectory({ profile: a.profile });
  const rejected = assert.rejects(scanning, { code: 'CANCELLED' });
  await ready;
  await a.value.pause();
  release();
  await rejected;
  assert.deepEqual(await store.loadTask(before.taskId), before);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.draft.task.queue.length, 4);
  assert.equal(a.value.task.queue.length, 3);
});

test('deletion during directory discovery remains authoritative and does not trigger automatic recreation', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  const taskId = a.value.task.taskId;
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    ready = new Promise((resolve) => (entered = resolve));
  a.io.discover = async () => {
    entered();
    await gate;
    return { items: a.chapters };
  };
  const scanning = a.value.scanDirectory({ profile: a.profile });
  const rejected = assert.rejects(scanning, /任务已删除/);
  await ready;
  await store.deleteTask(taskId);
  release();
  await rejected;
  assert.equal(await store.loadTask(taskId), null);
  assert.equal(await store.getSetting('deleted-task:' + taskId), true);
  assert.equal((await store.listTasks()).length, 0);
  assert.equal(a.value.initialized, false);
});

test('rotation sources reject scanning and fresh task creation before touching IO or storage', async (t) => {
  const p = setup(t),
    a = p.session(1, { purpose: 'rotation' });
  await assert.rejects(a.value.scanDirectory({ detect: true }), /轮换.*独立标签页/);
  await assert.rejects(a.value.createFreshTask(a.profile), /轮换.*独立标签页/);
  assert.equal(a.calls.scans.length, 0);
  assert.equal((await store.listTasks()).length, 0);
});

test('rescan preserves newly chosen validation chapters and requires their fresh verification', async (t) => {
  const p = setup(t),
    a = p.session(1);
  await a.value.initialize();
  await a.value.start();
  const before = await store.loadTask(a.value.task.taskId);
  assert.ok(before.validation);
  const chosen = validateProfile({ ...a.value.profile, samples: [a.chapters[2], a.chapters[0]] });
  const result = await a.value.scanDirectory({ profile: chosen });
  assert.deepEqual(result.profile.samples, chosen.samples);
  const saved = await store.loadTask(before.taskId);
  assert.deepEqual(saved.pages, before.pages);
  assert.deepEqual(saved.profile.samples, chosen.samples);
  assert.equal(saved.validation, undefined, 'new sample choice cannot inherit previous proof');
  let verified;
  a.io.verifySamples = async (profile) => {
    verified = profile.samples;
    return { verified: true };
  };
  await a.value.start();
  assert.deepEqual(verified, chosen.samples);
});

for (const failure of ['missing-region'])
  test(`initialization exposes an unsaved ${failure} repair candidate without replacing the archive`, async (t) => {
    const p = setup(t),
      a = p.session(1);
    a.profile.tocSelector = '#hand-picked-tree';
    const old = await saveIncomplete(a, 'contentSelector');
    const candidate =
      failure === 'missing-region'
        ? { ...a.profile, contentSelector: '' }
        : { ...a.profile, tocSelector: '#detected-tree', contentSelector: 'main' };
    a.io.detect = async () => ({ profile: candidate, warnings: ['Needs confirmation'] });
    await a.value.start();
    assert.ok(a.value.draft, 'failed repair must expose the detected candidate for calibration');
    assert.equal(a.value.draft.profile.tocSelector, candidate.tocSelector);
    assert.equal(a.value.draft.profile.contentSelector, candidate.contentSelector);
    assert.notEqual(a.value.draft.profile.id, old.profile.id);
    assert.notEqual(a.value.draft.task.taskId, old.task.taskId);
    assert.equal(a.value.draft.task.product, old.task.product);
    assert.deepEqual(a.value.draft.warnings, ['Needs confirmation']);
    assert.deepEqual(a.value.draft.task.pages, {});
    assert.deepEqual(a.value.task, old.task);
    assert.deepEqual(a.value.profile, old.profile);
    assert.equal(a.value.initialized, false);
    assert.equal(a.value.getState().canStart, false);
    assert.deepEqual(await store.loadTask(old.task.taskId), old.task);
    assert.equal((await store.listTasks()).length, 1);
    assert.equal((await store.loadProfiles()).length, 1);
    assert.equal(a.calls.captured.length, 0);
    assert.equal(a.calls.verify, 0);
    assert.equal(a.calls.scans.length, 0);
  });

test('first initialization failure exposes its candidate and successful retry clears the draft', async (t) => {
  const p = setup(t),
    a = p.session(1);
  a.io.detect = async () => ({
    profile: { ...a.profile, tocSelector: '' },
    warnings: ['Missing tree'],
  });
  await a.value.initialize();
  assert.ok(a.value.draft);
  assert.equal(a.value.draft.profile.tocSelector, '');
  assert.equal(a.value.task, null);
  assert.equal((await store.listTasks()).length, 0);
  a.io.detect = async () => ({ profile: a.profile, warnings: [] });
  await a.value.initialize();
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.draft, null);
});

test('explicit adoption clears an obsolete calibration draft', async (t) => {
  const p = setup(t),
    a = p.session(1);
  a.value.draft = { profile: { ...a.profile, tocSelector: '' }, task: null, warnings: [] };
  a.value.adopt(createTask(a.profile), a.profile);
  assert.equal(a.value.draft, null);
});

test('bulk readiness requires recognition, enough validation chapters and remaining work', async (t) => {
  const p = setup(t),
    a = p.session(41);
  await a.value.connect();
  assert.equal(a.value.getState().canStartBatch, false);
  await a.value.initialize();
  assert.equal(a.value.getState().canStartBatch, true);
  const chapters = [...a.value.task.queue];
  a.value.task.queue = chapters.slice(0, 1);
  assert.equal(a.value.getState().canStartBatch, false);
  a.value.task.queue = chapters;
  await a.value.start();
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.value.getState().canStartBatch, false);
});

test('transient recovery backs off quickly, then resets after durable chapter progress', async (t) => {
  const a = setup(t).session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  assert.ok(a.calls.timers.at(-1).delay <= 5000);
  await a.calls.timers.at(-1).callback();
  assert.ok(a.calls.timers.at(-1).delay > 14000 && a.calls.timers.at(-1).delay <= 15000);
  const capture = a.io.capture;
  a.io.capture = async (chapter, profile) => {
    a.calls.networkError = chapter.title !== 'a';
    return capture(chapter, profile);
  };
  await a.calls.timers.at(-1).callback();
  assert.equal(a.value.getState().progress.captured, 1);
  assert.ok(a.calls.timers.at(-1).delay <= 5000);
  a.calls.networkError = false;
  a.io.capture = capture;
  await a.value.start();
  assert.equal(a.calls.recover, 3, 'manual resume also reconnects after a transient failure');
  assert.equal(a.value.getState().status, 'finished');
});

// Reproduces duplicate legacy calibrations with equally recent archives.
test('explicit re-detection bypasses ambiguous duplicate archives and then reuses its own result', async (t) => {
  const { session } = setup(t),
    a = session(1);
  const originals = [];
  for (const id of ['legacy-a', 'legacy-b']) {
    const profile = { ...a.profile, id };
    const task = createTask(profile, 'Old', '1');
    task.queue = [{ ...a.chapters[0], status: 'captured' }];
    task.pages[a.chapters[0].key] = { text: 'Original ' + id, capturedAt: 'old' };
    task.updatedAt = '2020-01-01T00:00:00Z';
    await store.saveProfile(profile);
    await store.saveTask(task, a.chapters[0].key);
    originals.push(await store.loadTask(task.taskId));
  }
  await a.value.scanDirectory({ detect: true });
  assert.equal(a.value.initialized, true);
  assert.equal(a.value.task.queue.length, 3);
  assert.ok(!originals.some((task) => task.taskId === a.value.task.taskId));
  const currentId = a.value.task.taskId;
  await a.value.scanDirectory({ detect: true });
  assert.equal(a.value.task.taskId, currentId);
  for (const original of originals)
    assert.deepEqual(await store.loadTask(original.taskId), original);
  assert.equal((await store.listTasks()).length, 3);
  assert.equal(a.calls.captured.length, 0);
  assert.deepEqual(a.calls.scans, [{ expand: false }, { expand: false }]);
});

test('re-detecting another known chapter keeps its original manual identity and saved body', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  await a.value.captureCurrent();
  const original = await store.loadTask(a.value.task.taskId);
  a.io.tab = async () => ({ id: 1, url: a.chapters[2].url });
  a.io.detect = async () => ({ profile: { ...a.profile, entry: a.chapters[2].url } });
  await a.value.scanDirectory({ detect: true });
  assert.equal(a.value.task.taskId, original.taskId);
  assert.deepEqual(a.value.task.pages, original.pages);
  assert.equal((await store.listTasks()).length, 1);
});

test('worker restoration uses its bound task even if historical archives have tied dates', async (t) => {
  const { session } = setup(t),
    a = session(1);
  const tasks = [];
  for (const id of ['chosen', 'other']) {
    const profile = { ...a.profile, id };
    const task = createTask(profile, 'Old manual', '1');
    task.queue = a.chapters.map((chapter) => ({ ...chapter, status: 'pending' }));
    task.updatedAt = '2020-01-01T00:00:00Z';
    await store.saveProfile(profile);
    await store.saveTask(task);
    tasks.push(task);
  }
  await a.value.initialize({ taskId: tasks[0].taskId });
  assert.equal(a.value.task.taskId, tasks[0].taskId);
  assert.equal((await store.listTasks()).length, 2);
  assert.equal(a.calls.scans.length, 0);
});

test('a click-driven tree reuses only a currently selected locator in its bound task', async (t) => {
  const { session } = setup(t),
    a = session(1);
  a.profile.navigation = 'click';
  a.profile.queryKeys = ['page'];
  a.profile.entry += '?page=1';
  a.chapters.splice(
    0,
    a.chapters.length,
    ...['one', 'two'].map((title) => ({
      title,
      url: a.profile.entry,
      locator: { kind: 'generic-toc', path: [title] },
      key: 'toc:' + encodeURIComponent(JSON.stringify(['generic-toc', [title], ''])),
    })),
  );
  await a.value.initialize();
  const id = a.value.task.taskId;
  a.io.tab = async () => ({ id: 1, url: a.profile.entry.replace('page=1', 'page=2') });
  a.io.detect = async () => ({ profile: { ...a.profile, entry: (await a.io.tab()).url } });
  await a.value.scanDirectory({ detect: true });
  assert.equal(a.value.task.taskId, id);
  a.io.current = async () => ({
    status: 'ok',
    chapter: { ...a.chapters[1], locator: { kind: 'generic-toc', path: ['unrelated'] } },
  });
  a.io.tab = async () => ({ id: 1, url: a.profile.entry.replace('page=1', 'page=3') });
  await a.value.scanDirectory({ detect: true });
  assert.notEqual(
    a.value.task.taskId,
    id,
    'same selectors without a known selected chapter cannot establish task identity',
  );
});

test('an explicit restored task takes precedence over an obsolete automatic recovery binding', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  a.calls.networkError = true;
  await a.value.start();
  const oldId = a.value.task.taskId;
  a.value.dispose();
  const profile = { ...a.profile, id: 'explicit-choice' };
  const chosen = createTask(profile);
  chosen.queue = a.chapters.map((chapter) => ({ ...chapter, status: 'pending' }));
  await store.saveProfile(profile);
  await store.saveTask(chosen);
  const reopened = session(1);
  await reopened.value.initialize({ taskId: chosen.taskId });
  assert.equal(reopened.value.task.taskId, chosen.taskId);
  assert.notEqual(reopened.value.task.taskId, oldId);
  assert.equal(reopened.calls.timers.length, 0);
});

for (const recovering of [false, true])
  test(`restoring a bound click tree on another selected chapter (automatic recovery: ${recovering})`, async (t) => {
    const { session } = setup(t),
      a = session(1);
    a.profile.navigation = 'click';
    a.profile.queryKeys = ['page'];
    a.profile.entry += '?page=1';
    a.chapters.splice(
      0,
      a.chapters.length,
      ...['one', 'two'].map((title) => ({
        title,
        url: a.profile.entry,
        locator: { kind: 'generic-toc', path: [title] },
        key: 'toc:' + encodeURIComponent(JSON.stringify(['generic-toc', [title], ''])),
      })),
    );
    await a.value.initialize();
    if (recovering) {
      a.calls.networkError = true;
      await a.value.start();
    }
    const id = a.value.task.taskId;
    a.value.dispose();
    const reopened = session(1);
    reopened.io.tab = async () => ({ id: 1, url: a.profile.entry.replace('page=1', 'page=2') });
    reopened.io.current = async () => ({ status: 'ok', chapter: a.chapters[1] });
    await reopened.value.initialize({ taskId: id });
    assert.equal(reopened.value.initialized, true, reopened.value.error);
    assert.equal(reopened.value.task.taskId, id);
    assert.equal(reopened.calls.timers.length, recovering ? 1 : 0);
    assert.equal(reopened.calls.scans.length, 0);
    assert.equal((await store.listTasks()).length, 1);
  });

test('manual resume checks a task-wide failure before consuming another chapter and retries the interrupted chapter', async (t) => {
  const a = setup(t).session(1);
  await a.value.initialize();
  const capture = a.io.capture;
  a.io.capture = async (chapter, profile) => {
    if (chapter.key === a.chapters[0].key)
      return { status: 'error', error: '页面定位规则失效或不唯一，请重新校准' };
    return capture(chapter, profile);
  };
  await a.value.start();
  assert.equal(a.value.task.queue.filter((c) => c.status === 'failed').length, 1);
  assert.match(a.value.getState().error, /定位规则失效/);
  assert.match(a.value.task.errorLog[0].message, /定位规则失效/);
  assert.equal(a.value.task.errorLog[0].chapterTitle, 'a');
  a.io.recover = async () => {
    throw new Error('页面定位规则失效或不唯一，请重新校准');
  };
  await a.value.start();
  assert.deepEqual(
    a.value.task.queue.map((c) => c.status),
    ['failed', 'pending', 'pending'],
  );
  assert.equal(a.calls.captured.length, 0, 'failed recovery must leave the next chapter untouched');
  a.io.recover = async () => ({ status: 'ok' });
  a.io.capture = capture;
  await a.value.start();
  assert.equal(
    a.value.getState().progress.captured,
    3,
    'successful recovery retries the interrupted chapter too',
  );
  assert.equal(a.value.getState().error, '');
  assert.equal(a.value.task.status, 'finished');
});

test('duplicate bodies are kept for review without stopping the remaining queue', async (t) => {
  const a = setup(t).session(1);
  await a.value.initialize();
  a.io.capture = async () => ({
    status: 'ok',
    text: 'same body',
    navigationProof: { verified: true },
  });
  await a.value.start();
  assert.equal(a.value.task.status, 'finished');
  assert.deepEqual(
    a.value.task.queue.map((c) => c.status),
    ['captured', 'review', 'review'],
  );
  assert.equal(Object.keys(a.value.task.pages).length, 3);
  assert.equal(a.value.getState().error, '');
});

test('automatic network recovery leaves older failures requiring manual intervention untouched', async (t) => {
  const a = setup(t).session(1);
  await a.value.initialize();
  Object.assign(a.value.task.queue[0], {
    status: 'failed',
    error: '需手动校准',
    recovery: { scope: 'task', retryable: false, reason: 'intervention' },
  });
  a.value.task.status = 'retry_wait';
  a.value.task.recovery = {
    scope: 'task',
    retryable: true,
    reason: 'network',
    message: 'Failed to fetch',
  };
  a.value.task.autoRecovery = { enabled: true, sourceTabId: 1, nextAttemptAt: Date.now() + 1000 };
  await store.saveTask(a.value.task);
  await a.value.start({ automatic: true, expectedTaskId: a.value.task.taskId });
  assert.equal(a.value.task.queue[0].status, 'failed');
  assert.equal(a.calls.captured.includes(a.chapters[0].key), false);
  assert.equal(a.value.task.queue.filter((c) => c.status === 'captured').length, 2);
});

test('failed region preflight cannot consume or reset another chapter on resume', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  a.value.task.queue[0].status = 'failed';
  a.value.task.queue[0].error = '页面定位规则失效或不唯一，请重新校准';
  a.value.task.queue[0].recovery = { scope: 'task', retryable: false, reason: 'intervention' };
  a.value.task.recovery = {
    ...a.value.task.queue[0].recovery,
    message: a.value.task.queue[0].error,
  };
  await store.saveTask(a.value.task);
  const before = structuredClone(a.value.task.queue);
  a.io.prepare = async () => {
    throw new Error('目录定位匹配 2 个区域，请重新校准');
  };
  await a.value.start();
  assert.deepEqual(a.value.task.queue, before);
  assert.equal(a.calls.captured.length, 0);
  assert.match(a.value.getState().error, /目录定位匹配 2/);
});

test('verified binding repair keeps task and saved pages while retrying its interrupted chapter', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  const task = a.value.task;
  task.queue[0].status = 'captured';
  task.pages[task.queue[0].key] = {
    text: 'Original saved content',
    hash: 'original',
    capturedAt: 'original',
  };
  task.queue[1].status = 'failed';
  task.queue[1].recovery = { scope: 'task', retryable: false, reason: 'intervention' };
  task.recovery = { ...task.queue[1].recovery, message: '目录定位失效，请重新校准' };
  await store.saveTask(task, task.queue[0].key);
  const original = structuredClone(task.pages);
  a.io.prepare = async (profile, queue) => {
    assert.equal(queue.length, 3);
    return {
      status: 'ok',
      changed: true,
      profile: { ...profile, tocSelector: '.toc' },
      verified: true,
    };
  };
  await a.value.start();
  assert.equal(a.value.task.taskId, task.taskId);
  assert.equal(a.value.task.profile.tocSelector, '.toc');
  assert.equal(a.value.task.validation.signature, ruleSignature(a.value.task.profile));
  assert.deepEqual(a.value.task.pages[task.queue[0].key], original[task.queue[0].key]);
  assert.equal(a.calls.captured.length, 2);
  assert.equal(a.value.task.status, 'finished');
});

test('rotation blocks recovery and binding sample navigation before either starts', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  a.value.task.recovery = { scope: 'task', retryable: false, message: '重新校准' };
  await store.saveTask(a.value.task);
  let prepared = 0;
  a.io.isRotating = async () => true;
  a.io.prepare = async () => {
    prepared++;
    return { status: 'ok', changed: false };
  };
  await a.value.start();
  assert.equal(prepared, 0);
  assert.equal(a.calls.recover, 0);
  assert.equal(a.calls.captured.length, 0);
});

test('pause during binding persistence keeps the prior rule in memory and storage', async (t) => {
  const { session } = setup(t),
    a = session(1);
  await a.value.initialize();
  const original = structuredClone(a.value.profile);
  a.io.prepare = async (profile) => ({
    status: 'ok',
    changed: true,
    verified: true,
    profile: { ...profile, tocSelector: '.toc' },
  });
  a.value.store = {
    ...store,
    saveTask: async (task, key, options) => {
      if (task.profile.tocSelector === '.toc') {
        await a.value.pause();
        return store.saveTask(task, key, options);
      }
      return store.saveTask(task, key, options);
    },
  };
  await a.value.start();
  assert.deepEqual(a.value.profile, original);
  assert.deepEqual(a.value.task.profile, original);
  assert.deepEqual((await store.loadTask(a.value.task.taskId)).profile, original);
  assert.equal(a.calls.captured.length, 0);
});

for (const automatic of [false, true])
  for (const known of [false, true])
    test(`restoring a stale click binding uses a read-only known chapter proof (automatic=${automatic}, known=${known})`, async (t) => {
      const { session } = setup(t),
        a = session(1);
      const profile = {
        ...a.profile,
        navigation: 'click',
        queryKeys: ['page'],
        tocSelector: '#ext-gen-old',
        entry: a.profile.entry + '?page=1',
      };
      const chapters = ['one', 'two'].map((title) => ({
        title,
        url: profile.entry,
        locator: { kind: 'generic-toc', path: [title] },
        key: 'toc:' + encodeURIComponent(JSON.stringify(['generic-toc', [title], ''])),
      }));
      const task = createTask(profile);
      task.queue = chapters.map((c) => ({ ...c, status: 'pending' }));
      task.pages[chapters[0].key] = { text: 'Original', hash: 'original' };
      task.autoRecovery = { enabled: automatic, sourceTabId: 1, nextAttemptAt: Date.now() + 60000 };
      await store.saveTask(task, chapters[0].key);
      await store.saveProfile(profile);
      await store.setSetting('recovery-tab:1', task.taskId);
      a.io.tab = async () => ({ url: profile.entry.replace('page=1', 'page=8') });
      a.io.current = async () => {
        throw new Error('must use read-only binding-aware confirmation');
      };
      a.io.boundCurrent = async () => ({
        status: 'ok',
        chapter: known
          ? chapters[1]
          : {
              ...chapters[1],
              title: 'Unknown',
              locator: { kind: 'generic-toc', path: ['Unknown'] },
            },
      });
      await a.value.initialize({ taskId: task.taskId });
      assert.equal(a.value.initialized, known);
      assert.deepEqual((await store.loadTask(task.taskId)).profile, profile);
      assert.deepEqual((await store.loadTask(task.taskId)).pages, task.pages);
      assert.equal(a.calls.recover, 0);
      assert.equal(a.calls.captured.length, 0);
      assert.equal(a.calls.verify, 0);
    });

async function verifiedScanFailure(t, { edited = false } = {}) {
  const a = setup(t).session(1);
  await a.value.initialize();
  await a.value.validate(() => true);
  const saved = a.value.task.queue[0];
  saved.status = 'captured';
  a.value.task.pages[saved.key] = {
    text: 'Original body',
    hash: 'original-hash',
    capturedAt: 'original-time',
  };
  await store.saveTask(a.value.task, saved.key);
  const before = await store.loadTask(a.value.task.taskId);
  a.io.discover = async () => ({ status: 'error', error: '目录定位匹配多个普通区域，请重新校准' });
  await assert.rejects(
    a.value.scanDirectory({
      profile: edited ? { ...a.value.profile, tocSelector: '#edited-tree' } : a.value.profile,
    }),
    /目录|规则/,
  );
  return { ...a, before };
}

test('a verified task can recheck a failed rescan without accepting the failed draft or advancing its queue', async (t) => {
  const a = await verifiedScanFailure(t);
  assert.equal(a.value.getState().canResume, true);
  assert.equal(a.value.getState().canStart, true);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.getState().status, 'needs_calibration');
  const checked = [];
  a.io.recover = async () => {
    checked.push('recover');
    return { status: 'ok' };
  };
  a.io.prepare = async () => {
    checked.push('prepare');
    throw new Error('目录仍有歧义');
  };
  await a.value.start();
  assert.deepEqual(checked, ['recover', 'prepare']);
  assert.deepEqual(a.value.task.queue, a.before.queue);
  assert.deepEqual(a.value.task.pages, a.before.pages);
  assert.equal(a.value.initialized, false);
  assert.equal(a.value.getState().status, 'needs_calibration');
  assert.equal(a.value.getState().canResume, true);
  assert.deepEqual(a.calls.captured, []);
  a.io.prepare = async () => {
    checked.push('prepare');
    return { status: 'ok', changed: false, profile: a.value.profile };
  };
  await a.value.start();
  assert.deepEqual(checked, ['recover', 'prepare', 'recover', 'prepare']);
  assert.equal(a.value.task.taskId, a.before.taskId);
  assert.deepEqual(
    a.value.task.pages[a.before.queue[0].key],
    a.before.pages[a.before.queue[0].key],
  );
  assert.equal(a.value.getState().progress.captured, 3);
  assert.equal(a.value.draft, null);
  assert.equal(a.value.task.status, 'finished');
});

test('a failed edited rule cannot use the validated old task as permission to collect its draft', async (t) => {
  const a = await verifiedScanFailure(t, { edited: true });
  assert.equal(a.value.getState().canResume, false);
  assert.equal(a.value.getState().canStart, false);
  let checked = 0;
  a.io.prepare = async () => {
    checked++;
    return { status: 'ok' };
  };
  await a.value.start({ retry: true });
  assert.equal(checked, 0);
  assert.deepEqual(a.calls.captured, []);
  assert.deepEqual(await store.loadTask(a.before.taskId), a.before);
  assert.equal(a.value.draft.profile.tocSelector, '#edited-tree');
});

test('rescan recovery eligibility survives serialized snapshots but rejects changed validation samples', async (t) => {
  const a = await verifiedScanFailure(t);
  a.value.draft = structuredClone(a.value.draft);
  a.value.task = structuredClone(a.value.task);
  a.value.profile = structuredClone(a.value.profile);
  assert.equal(a.value.getState().canResume, true);
  a.value.draft.profile.samples = [a.chapters[1], a.chapters[2]];
  assert.equal(a.value.getState().canResume, false);
  assert.equal(a.value.getState().canStart, false);
});

test('failed-rescan recovery does not enable current capture or run without a prepare check', async (t) => {
  const a = await verifiedScanFailure(t);
  assert.equal(a.value.getState().canCaptureCurrent, false);
  await a.value.captureCurrent();
  await a.value.start();
  assert.deepEqual(a.calls.captured, []);
  assert.deepEqual(a.value.task.queue, a.before.queue);
  assert.deepEqual(a.value.task.pages, a.before.pages);
  assert.equal(a.value.initialized, false);
  assert.notEqual(a.value.draft, null);
});

test('failed-rescan recovery rejects a changed task identity before any navigation', async (t) => {
  const a = await verifiedScanFailure(t);
  a.value.draft.task.product = 'Changed product';
  assert.equal(a.value.getState().canResume, false);
  await a.value.start({ retry: true });
  assert.equal(a.calls.recover, 0);
  assert.deepEqual(a.calls.captured, []);
  assert.deepEqual(await store.loadTask(a.before.taskId), a.before);
});
