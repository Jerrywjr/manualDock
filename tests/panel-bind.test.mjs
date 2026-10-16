import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBind, loginURL } from '../extension/bind-check.js';

// Pure pre-flight binding checks (panel.checkBind runs these before any
// chrome.scripting call). These are the rejection branches the review brief §3
// asks for: foreign origin, login page, invalid/out-of-scope rule.
const PROFILE = {
  origin: 'https://manual.example.com',
  entry: 'https://manual.example.com/',
  pathPrefix: '/docs',
  queryKeys: [],
  tocSelector: '',
  contentSelector: '',
};

test('a foreign-origin tab is rejected before any page-side check', () => {
  const r = classifyBind(PROFILE, 'https://evil.example.org/docs/ch1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /manual\.example\.com/);
});

test('a login page is rejected', () => {
  assert.equal(loginURL('https://manual.example.com/login'), true);
  const r = classifyBind(PROFILE, 'https://manual.example.com/login?next=/docs');
  assert.equal(r.ok, false);
  assert.match(r.reason, /登录页/);
});

test('a same-origin URL outside the path prefix is rejected (invalid rule / scope)', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/elsewhere/ch1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /手册范围/);
});

test('a URL carrying a non-whitelisted query parameter is rejected', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/docs/ch1?token=ABC123');
  assert.equal(r.ok, false);
});

test('an allowed query parameter is accepted', () => {
  const p = { ...PROFILE, queryKeys: ['p'] };
  const r = classifyBind(p, 'https://manual.example.com/docs/ch1?p=42');
  assert.equal(r.ok, true);
});

test('a valid in-scope, non-login page passes the pre-flight', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/docs/ch1');
  assert.equal(r.ok, true);
});

test('a missing profile or unreadable URL is rejected', () => {
  assert.equal(classifyBind(null, 'https://manual.example.com/docs/ch1').ok, false);
  assert.equal(classifyBind(PROFILE, '').ok, false);
  assert.equal(classifyBind(PROFILE, 'not a url').ok, false);
});

// Exercise the actual panel handlers with a failed scan snapshot; direct dispatch
// also covers stale enabled buttons while a new worker snapshot is arriving.
const { readFile } = await import('node:fs/promises');
const { runInNewContext } = await import('node:vm');
const { ruleSignature, validateProfile, jobKey } = await import('../extension/profiles.js');
const panelSource = await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8');
function failedScanPanel({ resumable = true } = {}) {
  const profile = validateProfile({
    schemaVersion: 1,
    id: 'rescan',
    revision: 1,
    name: 'API',
    adapterId: 'generic',
    entry: 'https://manual.test/docs',
    pathPrefix: '/',
    tocSelector: 'nav',
    contentSelector: 'main',
    samples: ['a', 'b'].map((title) => ({ title, url: 'https://manual.test/' + title })),
  });
  const task = {
    taskId: jobKey(profile, 'API', '1'),
    sourceKind: 'web',
    profileId: profile.id,
    profileRevision: profile.revision,
    product: 'API',
    version: '1',
    profile,
    queue: ['a', 'b', 'c'].map((title) => ({
      title,
      status: title === 'a' ? 'captured' : 'pending',
    })),
    pages: { a: { text: 'Original body' } },
  };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { disabled: false, value: '', dataset: {} });
    return elements.get(id);
  };
  for (const [id, value] of Object.entries({
    product: 'API',
    version: '1',
    scope: '/',
    'toc-selector': 'nav',
    'content-selector': 'main',
    'hash-mode': 'none',
  }))
    $(id).value = value;
  const calls = [];
  const session = {
    task: structuredClone(task),
    profile: structuredClone(profile),
    draft: { task, profile },
    busy: false,
    error: '目录定位匹配多个普通区域',
    getState: () => ({ canResume: resumable }),
    start: async (options) => calls.push(['start', options]),
    captureCurrent: async () => calls.push(['current']),
    adopt: async () => calls.push(['adopt']),
  };
  const context = {
    $,
    task,
    profile,
    selectedSession: session,
    sampleSlots: [...profile.samples],
    initialized: true,
    busy: false,
    selectionPending: false,
    tabId: 1,
    render() {},
    clearError() {},
    error(e) {
      throw e;
    },
    navigator: { locks: { request: async (_name, _options, action) => action({}) } },
    readOnlyTask: false,
    detectionWarnings: [],
    ruleSignature,
    jobKey,
    chrome: {},
    locked: async (action) => {
      calls.push(['lock']);
      await action();
    },
    withTaskLock: async (action) => {
      calls.push(['task-lock']);
      await action();
    },
    saveTask: async () => calls.push(['save']),
  };
  const names = [
    'sameProfileRevision',
    'locked',
    'canResumeSelectedDraft',
    'renderRecognition',
    'startSelected',
  ];
  const functions = names
    .map(
      (name) =>
        panelSource.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))?.[0] ||
        '',
    )
    .join('\n');
  const api = runInNewContext(functions + ';({renderRecognition,startSelected,locked})', context);
  return { api, $, task, profile, calls, context, session };
}

test('failed scans expose the same recheck gate for continue and retry without permitting current-page capture', async () => {
  const p = failedScanPanel();
  p.api.renderRecognition(p.task.queue);
  assert.equal(p.$('start').disabled, false);
  assert.equal(p.$('retry').disabled, false);
  assert.equal(p.$('capture-current').disabled, true);
  assert.equal(p.$('start').textContent, '重新检查并继续采集');
  await p.api.startSelected();
  await p.api.startSelected({ retry: true });
  await p.api.startSelected({ currentOnly: true });
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls)), [
    ['start', { retry: false }],
    ['start', { retry: true }],
  ]);
});

for (const changed of [
  'unvalidated',
  'product',
  'version',
  'scope',
  'toc-selector',
  'content-selector',
  'hash-mode',
  'samples',
])
  test(
    'failed scan controls and dispatch reject a changed or unvalidated draft: ' + changed,
    async () => {
      const p = failedScanPanel({ resumable: changed !== 'unvalidated' });
      if (changed === 'samples') p.context.sampleSlots = [...p.profile.samples].reverse();
      else if (changed !== 'unvalidated') p.$(changed).value += '-edited';
      p.api.renderRecognition(p.task.queue);
      assert.equal(p.$('start').disabled, true);
      assert.equal(p.$('retry').disabled, true);
      assert.equal(p.$('capture-current').disabled, true);
      await p.api.startSelected();
      await p.api.startSelected({ retry: true });
      await p.api.startSelected({ currentOnly: true });
      assert.deepEqual(p.calls, []);
    },
  );

for (const edited of [false, true])
  test(
    'a successful panel action cannot adopt a failed scan draft, including edited samples: ' +
      edited,
    async () => {
      const p = failedScanPanel();
      await p.api.locked(async () => {
        if (edited) {
          p.context.profile = { ...p.profile, samples: [...p.profile.samples].reverse() };
          p.task.profile = p.context.profile;
        }
      });
      assert.deepEqual(p.calls, []);
      assert.notEqual(p.session.draft, null);
    },
  );
