import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RETRY_INTERVAL_MS,
  classifyRecoveryError,
  resetRetryableChapters,
  taskHasRetryableWork,
  faultOf,
  pushFault,
  resetInterruptedChapters,
  collectionMessage,
} from '../extension/recovery.js';

test('a fault keeps its identity and stage, carries no page content, and survives the script boundary', () => {
  const error = new TypeError('Illegal invocation');
  error.stack = 'TypeError: Illegal invocation\n    at locallyHidden (tree.js:143)';
  const fault = faultOf(error, 'open-directory', { key: 'toc:x', title: '配置示例' });
  assert.equal(fault.name, 'TypeError');
  assert.equal(fault.message, 'Illegal invocation');
  assert.match(fault.stack, /tree\.js:143/);
  assert.equal(fault.stage, 'open-directory');
  assert.equal(fault.chapterTitle, '配置示例');
  assert.equal(fault.chapterKey, 'toc:x');
  assert.deepEqual(
    Object.keys(fault).sort(),
    ['at', 'chapterKey', 'chapterTitle', 'message', 'name', 'stack', 'stage'],
    'a fault must not carry page content, form values, cookies or credentials',
  );
  // chrome.scripting.executeScript() moves values by structured clone.
  assert.deepEqual(structuredClone(fault), fault);
  assert.ok(faultOf('boom', 's', null).message === 'boom');
});

test('faults are stored newest first and bounded so a long manual cannot grow without limit', () => {
  const task = {};
  for (let i = 0; i < 80; i++)
    pushFault(task, faultOf(new Error('e' + i), 'capture-chapter', null));
  assert.equal(task.errorLog.length, 50);
  assert.equal(task.errorLog[0].message, 'e79');
  assert.equal(pushFault(null, faultOf(new Error('x'), 's', null)), null);
});

test('the automatic recovery interval is exactly three minutes', () =>
  assert.equal(RETRY_INTERVAL_MS, 180000));
test('temporary network, loading and authentication failures are distinguished from configuration errors', () => {
  for (const input of [
    new TypeError('Failed to fetch'),
    new Error('net::ERR_INTERNET_DISCONNECTED'),
    { status: 'auth' },
    new Error('45秒内未确认章节和正文完成切换，未保存旧正文'),
    new Error('Execution context was destroyed'),
    new Error('Frame with ID 0 is showing error page'),
  ])
    assert.equal(classifyRecoveryError(input).retryable, true, String(input));
  for (const message of [
    '两个示例正文相同',
    'Cannot access contents of url. Extension manifest must request permission.',
    '原标签页已关闭，请从已登录的页面重新点击扩展',
    '无法唯一打开所选章节',
    '未确认所选章节的正文加载完成',
    '原标签页已离开手册网站',
  ])
    assert.equal(classifyRecoveryError(new Error(message)).retryable, false, message);
  assert.equal(classifyRecoveryError({ status: 'auth' }).reason, 'auth');
});
test('automatic reset preserves captured and review pages and only requeues recoverable failures', () => {
  const task = {
    sourceKind: 'web',
    queue: [
      { key: 'saved', status: 'captured' },
      { key: 'duplicate', status: 'review', error: 'same text' },
      {
        key: 'offline',
        status: 'failed',
        error: 'offline',
        recovery: { retryable: true, reason: 'network' },
      },
      {
        key: 'ambiguous',
        status: 'failed',
        error: 'ambiguous',
        recovery: { retryable: false, reason: 'intervention' },
      },
      { key: 'auth', status: 'waiting_login' },
    ],
    pages: { saved: { text: 'A' }, duplicate: { text: 'A' } },
  };
  const pages = JSON.stringify(task.pages);
  assert.equal(taskHasRetryableWork(task), true);
  assert.equal(resetRetryableChapters(task), 2);
  assert.deepEqual(
    task.queue.map((c) => c.status),
    ['captured', 'review', 'pending', 'failed', 'pending'],
  );
  assert.equal(JSON.stringify(task.pages), pages);
  assert.equal(taskHasRetryableWork(task), false);
});
test('a recoverable preflight failure can resume an empty or pending queue but never an already completed import', () => {
  const recovery = { retryable: true, reason: 'network' };
  assert.equal(taskHasRetryableWork({ sourceKind: 'web', queue: [], recovery }), true);
  assert.equal(
    taskHasRetryableWork({ sourceKind: 'web', queue: [{ status: 'pending' }], recovery }),
    true,
  );
  assert.equal(
    taskHasRetryableWork({
      sourceKind: 'web',
      queue: [{ status: 'captured' }, { status: 'review' }],
      recovery,
    }),
    false,
  );
  assert.equal(taskHasRetryableWork({ sourceKind: 'openapi', queue: [], recovery }), false);
});

test('a permanent current preflight failure stops retries even when an earlier chapter failed transiently', () => {
  const task = {
    sourceKind: 'web',
    recovery: { retryable: false, reason: 'intervention' },
    queue: [
      { status: 'failed', recovery: { retryable: true, reason: 'network' } },
      { status: 'pending' },
    ],
  };
  assert.equal(taskHasRetryableWork(task), false);
});

test('faultOf redacts credentials from message and stack while keeping identity', () => {
  const error = new Error(
    'GET https://docs.example.com/api/toc?token=SECRETTOKEN&api_key=AK123 failed: Authorization: Bearer eyJabc.def.ghi ; Cookie: sess=XYZ',
  );
  error.stack =
    'Error: boom\n    at load (https://docs.example.com/api/toc?token=SECRETTOKEN#frag:1:1)\n    at x (https://docs.example.com/p?password=supersecret:2:2)';
  const fault = faultOf(error, 'capture-chapter', { key: 'k1', title: 'T1' });
  assert.equal(fault.name, 'Error');
  assert.equal(fault.stage, 'capture-chapter');
  assert.equal(fault.chapterKey, 'k1');
  assert.equal(fault.chapterTitle, 'T1');
  for (const secret of ['SECRETTOKEN', 'AK123', 'eyJabc', 'sess=XYZ', 'supersecret'])
    assert.ok(!fault.message.includes(secret) && !fault.stack.includes(secret), 'leaked ' + secret);
  // path is kept, query string / fragment (where tokens live) is dropped
  assert.ok(fault.message.includes('https://docs.example.com/api/toc'));
  assert.ok(!fault.message.includes('?token'));
  assert.ok(!fault.stack.includes('?token'));
});

test('pushFault redacts a raw fault object before it reaches the stored log', () => {
  const task = {};
  pushFault(task, { name: 'Error', message: 'token=ABC123', stack: 'at y?token=ABC123' });
  assert.equal(task.errorLog[0].message, 'token=<redacted>');
  assert.ok(!task.errorLog[0].stack.includes('ABC123'), 'stack leaked token');
});

test('classifyRecoveryError redacts the stored recovery message', () => {
  const r = classifyRecoveryError(new Error('fetch https://h?api_key=ZZZ failed'));
  assert.ok(!r.message.includes('ZZZ'));
  assert.ok(r.message.includes('https://h'));
});

// redact() has to be duplicated: recovery.js is an ES module while capture.js,
// tree.js and manual-adapters.js are IIFE content scripts that cannot import it.
// This keeps the four copies from drifting apart.
test('every copy of redact() is identical so one cannot silently drift from the others', async () => {
  const files = ['recovery.js', 'capture.js', 'tree.js', 'manual-adapters.js'];
  const normalize = async (name) => {
    const src = await readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8');
    const key = src.match(/const SENSITIVE_KEY\s*=[\s\S]*?;/)[0].replace(/\s+/g, '');
    const steps = [...src.matchAll(/s = s\.replace\([\s\S]*?\);/g)].map((m) =>
      m[0].replace(/\s+/g, '').replace(/,(?=\))/g, ''),
    );
    assert.equal(steps.length, 5, name + ' must keep exactly the five redaction steps');
    return key + '\n' + steps.join('\n');
  };
  const texts = await Promise.all(files.map(normalize));
  for (const text of texts.slice(1))
    assert.equal(text, texts[0], 'a redact() copy drifted from recovery.js');
  assert.match(
    texts[0],
    /\[\^\\s"'<>\?#\]\+/,
    'the URL base must exclude ? and # so query strings are stripped',
  );
});

test('a chapter-local permanent failure does not hide another chapter waiting for retry', () => {
  const task = {
    sourceKind: 'web',
    recovery: { retryable: false, reason: 'intervention', scope: 'chapter' },
    queue: [
      { status: 'failed', recovery: { retryable: true, reason: 'timeout', scope: 'chapter' } },
      {
        status: 'failed',
        recovery: { retryable: false, reason: 'intervention', scope: 'chapter' },
      },
    ],
  };
  assert.equal(taskHasRetryableWork(task), true);
  task.recovery = { retryable: false, reason: 'storage', scope: 'task' };
  assert.equal(taskHasRetryableWork(task), false);
});

test('retry backoff is capped, preserves login waits and survives malformed counters', async () => {
  const { scheduleRecovery } = await import('../extension/recovery.js');
  const task = { queue: [], recovery: { reason: 'network' }, autoRecovery: {} };
  const delays = [];
  for (let i = 0; i < 7; i++) {
    task.autoRecovery = scheduleRecovery(task, 0, 1000);
    delays.push(task.autoRecovery.nextAttemptAt - 1000);
  }
  assert.deepEqual(delays, [5000, 15000, 30000, 60000, 180000, 180000, 180000]);
  task.recovery.reason = 'auth';
  task.autoRecovery.failures = 0;
  assert.equal(scheduleRecovery(task, 0, 1000).nextAttemptAt, 181000);
  task.recovery.reason = 'network';
  task.autoRecovery.failures = 1.5;
  assert.ok(Number.isFinite(scheduleRecovery(task, 0, 1000).nextAttemptAt));
});

test('source recovery only requeues interrupted chapters with no saved body', () => {
  const task = {
    status: 'paused',
    sourceKind: 'web',
    queue: [
      { key: 'blocked', status: 'failed', error: 'blocked', recovery: { scope: 'task' } },
      { key: 'local', status: 'failed', error: 'local', recovery: { scope: 'chapter' } },
      { key: 'kept', status: 'failed', error: 'storage', recovery: { scope: 'task' } },
      { key: 'duplicate', status: 'review' },
      { key: 'captured', status: 'captured' },
    ],
    pages: {
      kept: { text: 'previous version' },
      duplicate: { text: 'same' },
      captured: { text: 'saved' },
    },
  };
  const before = structuredClone(task.pages);
  resetInterruptedChapters(task);
  assert.deepEqual(
    task.queue.map((c) => c.status),
    ['pending', 'failed', 'failed', 'review', 'captured'],
  );
  assert.equal(task.queue[0].error, undefined);
  assert.deepEqual(task.pages, before);
});

test('persisted pause explanation distinguishes failures, duplicates and retries and redacts credentials', () => {
  const task = {
    status: 'paused',
    recovery: { scope: 'task', message: '访问失败 https://docs.test/page?token=private' },
    queue: [{ status: 'failed' }, { status: 'review' }],
  };
  const text = collectionMessage(task);
  assert.match(text, /1 章失败，1 章正文待核对/);
  assert.match(text, /查看来源页/);
  assert.doesNotMatch(text, /private|token=/);
  task.status = 'retry_wait';
  task.autoRecovery = { enabled: true };
  assert.match(collectionMessage(task), /等待恢复.*自动重试/);
  task.status = 'running';
  assert.equal(collectionMessage(task), '');
});
