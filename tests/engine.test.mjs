import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, ImportEngine } from '../extension/engine.js';
import { resetRetryableChapters, taskHasRetryableWork } from '../extension/recovery.js';
const p = {
  schemaVersion: 1,
  id: 'p',
  revision: 1,
  adapterId: 'generic',
  entry: 'https://m.test/docs/index',
  origin: 'https://m.test',
  pathPrefix: '/docs',
  queryKeys: [],
  hashMode: 'route',
  tocSelector: 'nav',
  contentSelector: 'main',
  navigation: 'links',
};
const links = Array.from({ length: 1200 }, (_, i) => ({
  url: `https://m.test/docs/chapter-${i}`,
  title: `chapter ${i}`,
}));
function ioFor(task, onChange = () => {}) {
  return {
    discover: async () => ({ items: links, warnings: [] }),
    capture: async (chapter) => ({
      status: 'ok',
      url: chapter.url,
      title: chapter.title,
      text: 'body ' + chapter.title,
      markdown: 'body ' + chapter.title,
      html: '<p>body</p>',
      links: [],
      warnings: [],
      diagnostics: {},
      navigationProof: { verified: true, kind: 'url' },
    }),
    save: async () => {},
    onChange,
  };
}
test('1200 path chapters survive pause, snapshot and resume without recapturing old pages', async () => {
  const task = createTask(p, 'IPS', '1');
  let engine;
  engine = new ImportEngine(
    task,
    ioFor(task, () => {
      if (Object.keys(task.pages).length === 200) engine.pause();
    }),
  );
  await engine.run();
  assert.equal(Object.keys(task.pages).length, 200);
  assert.equal(task.status, 'paused');
  const restored = JSON.parse(JSON.stringify(task));
  const old = JSON.stringify(restored.pages);
  let calls = 0;
  const io = ioFor(restored);
  const capture = io.capture;
  io.capture = async (c) => {
    calls++;
    return capture(c);
  };
  await new ImportEngine(restored, io).run();
  assert.equal(calls, 1000);
  assert.equal(Object.keys(restored.pages).length, 1200);
  assert.equal(
    JSON.stringify(Object.fromEntries(Object.entries(restored.pages).slice(0, 200))),
    old,
  );
});
test('unverified content is never captured while other chapters remain eligible', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 4) });
  io.capture = async (c) => ({
    status: 'ok',
    url: c.url,
    text: 'stale',
    navigationProof: { verified: false },
  });
  await new ImportEngine(task, io).run();
  assert.equal(task.status, 'paused');
  assert.equal(task.queue.filter((c) => c.status === 'failed').length, 4);
  assert.equal(Object.keys(task.pages).length, 0);
});
test('authentication expiration pauses and resumes the same chapter', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 2) });
  const real = io.capture;
  io.capture = async () => ({ status: 'auth' });
  await new ImportEngine(task, io).run();
  assert.equal(task.status, 'waiting_login');
  io.capture = real;
  await new ImportEngine(task, io).run();
  assert.equal(task.queue.filter((c) => c.status === 'captured').length, 2);
});
test('same-url tree chapters stay distinct and identical bodies remain reviewable', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({
    items: ['A', 'B'].map((title) => ({
      url: p.entry,
      title,
      locator: { kind: 'generic-toc', path: [title] },
    })),
  });
  io.capture = async (c) => ({
    status: 'ok',
    url: c.url,
    text: 'same body',
    navigationProof: { verified: true },
  });
  await new ImportEngine(task, io).run();
  assert.equal(Object.keys(task.pages).length, 2);
  assert.equal(task.queue[1].status, 'review');
});

test('image-only chapters require embedded image evidence and preserve distinct content hashes', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 3) });
  io.capture = async (c) => ({
    status: 'ok',
    url: c.url,
    text: '',
    html: `<img src="data:image/png;base64,${c.title === 'chapter 0' ? 'AAAA' : 'BBBB'}">`,
    diagnostics: { images: { embedded: c.title === 'chapter 2' ? 0 : 1 } },
    navigationProof: { verified: true },
  });
  await new ImportEngine(task, io).run();
  assert.equal(Object.keys(task.pages).length, 2);
  assert.deepEqual(
    task.queue.map((c) => c.status),
    ['captured', 'captured', 'failed'],
  );
  assert.notEqual(...Object.values(task.pages).map((p) => p.hash));
});

test('network interruption saves good chapters and an automatic retry resumes only failed or pending work', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 5) });
  const capture = io.capture;
  let online = false,
    calls = [];
  io.capture = async (c) => {
    calls.push(c.key);
    if (!online && c.title !== 'chapter 0') throw new TypeError('Failed to fetch');
    return capture(c);
  };
  await new ImportEngine(task, io).run();
  assert.equal(task.status, 'paused');
  assert.equal(task.recovery.reason, 'network');
  assert.equal(taskHasRetryableWork(task), true);
  assert.equal(Object.keys(task.pages).length, 1);
  const saved = JSON.stringify(task.pages),
    first = task.queue[0].key;
  online = true;
  calls = [];
  assert.equal(resetRetryableChapters(task), 1);
  await new ImportEngine(task, io).run();
  assert.equal(task.status, 'finished');
  assert.equal(calls.includes(first), false);
  assert.equal(Object.keys(task.pages).length, 5);
  assert.equal(JSON.stringify({ [first]: task.pages[first] }), saved);
  assert.equal(taskHasRetryableWork(task), false);
});
test('a page-side failure keeps its identity, is logged, and is stored on the task', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 3) });
  // What the injected adapter now returns instead of a bare string.
  const failure = Object.assign(new TypeError('Illegal invocation'), {
    stage: 'open-directory',
    fault: {
      name: 'TypeError',
      message: 'Illegal invocation',
      stack: 'TypeError: Illegal invocation\n    at locallyHidden (tree.js:143)',
      stage: 'open-directory',
      chapterKey: 'toc:x',
    },
  });
  io.capture = async () => {
    throw failure;
  };
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  await new ImportEngine(task, io).run();
  console.error = real;
  assert.equal(task.queue[0].error, 'Illegal invocation', 'the message still reaches the user');
  assert.equal(task.errorLog.length, 3, 'every failed chapter is recorded');
  assert.equal(task.errorLog[0].name, 'TypeError');
  assert.equal(task.errorLog[0].stage, 'open-directory');
  assert.match(task.errorLog[0].stack, /tree\.js:143/);
  assert.ok(logged.length > 0, 'the failure must no longer be swallowed without a console record');
});
test('reopening an interrupted task continues the queue without rewriting saved pages', async () => {
  const task = createTask(p, 'IPS', '1');
  const makeIo = () => {
    const io = ioFor(task);
    io.discover = async () => ({ items: links.slice(0, 5) });
    return io;
  };
  let engine;
  const io1 = makeIo();
  io1.onChange = () => {
    if (Object.keys(task.pages).length === 2) engine.pause();
  };
  engine = new ImportEngine(task, io1);
  await engine.run();
  assert.equal(Object.keys(task.pages).length, 2);
  assert.equal(task.status, 'paused');
  assert.ok(
    task.heartbeat?.at,
    'a checkpoint writes a heartbeat so a closed console can be recognised',
  );
  const done = task.queue.filter((c) => c.status === 'captured').map((c) => c.key);
  const saved = JSON.stringify(task.pages);
  let calls = 0;
  const io2 = makeIo();
  const capture = io2.capture;
  io2.capture = async (chapter) => {
    calls++;
    return capture(chapter);
  };
  await new ImportEngine(task, io2).run();
  assert.equal(task.status, 'finished');
  assert.equal(calls, 3, 'only unfinished chapters are collected again');
  assert.equal(Object.keys(task.pages).length, 5);
  assert.equal(
    JSON.stringify(Object.fromEntries(done.map((key) => [key, task.pages[key]]))),
    saved,
    'already captured pages must stay unchanged',
  );
});
test('a chapter whose page cannot be stored stops the run without corrupting saved data', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 5) });
  const real = io.save;
  let keyed = 0;
  io.save = async (t, key) => {
    if (key && ++keyed === 2) throw new TypeError('Illegal invocation');
    return real(t, key);
  };
  await new ImportEngine(task, io).run();
  assert.equal(
    task.status,
    'paused',
    'storage failure must stop the run and wait for recovery, not finish',
  );
  assert.equal(
    task.queue.filter((c) => c.status === 'captured').length,
    1,
    'only chapters saved before the failure stay captured',
  );
  assert.equal(
    task.queue.filter((c) => c.status === 'failed').length,
    1,
    'the chapter that could not be stored is marked failed, never captured',
  );
  const failed = task.queue.find((c) => c.status === 'failed');
  assert.match(failed.error, /Illegal invocation/, 'the storage error is surfaced to the user');
  assert.equal(task.recovery.reason, 'storage');
  assert.equal(taskHasRetryableWork(task), false, 'a storage failure is not silently retried');
});
test('a transient discovery failure is recoverable before the first chapter has been found', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.discover = async () => {
    throw new Error('net::ERR_CONNECTION_RESET');
  };
  await assert.rejects(new ImportEngine(task, io).run(), /ERR_CONNECTION_RESET/);
  assert.equal(task.recovery.retryable, true);
  assert.equal(taskHasRetryableWork(task), true);
});
test('calibration and navigation proof failures never become automatic retry work', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.capture = async () => ({ status: 'ok', text: 'stale', navigationProof: { verified: false } });
  await new ImportEngine(task, io).run();
  assert.equal(task.recovery.retryable, false);
  assert.equal(taskHasRetryableWork(task), false);
  assert.equal(resetRetryableChapters(task), 0);
});

test('an invalid directory is not silently ignored when an older queue already exists', async () => {
  const task = createTask(p),
    io = ioFor(task);
  let captures = 0;
  io.discover = async () => ({ items: links.slice(0, 2) });
  await new ImportEngine(task, io).scan();
  io.discover = async () => ({
    items: [],
    warnings: ['目录定位器失效'],
    diagnostics: { reason: 'invalid-directory' },
  });
  io.capture = async () => {
    captures++;
    throw new Error('must not run');
  };
  await assert.rejects(new ImportEngine(task, io).scan(), /目录定位器失效/);
  assert.equal(captures, 0);
});
test('an interruption keeps the stack for diagnosis but stores it redacted', async () => {
  const task = createTask(p, 'IPS', '1'),
    io = ioFor(task);
  io.discover = async () => {
    throw Object.assign(new Error('boom'), {
      stack: 'Error: boom\n    at load (https://docs.test/api?token=SECRETTOKEN:1:1)',
    });
  };
  await assert.rejects(new ImportEngine(task, io).run(), /boom/);
  assert.ok(
    task.recovery.stack,
    'the stack is still stored so the failing frame can be identified',
  );
  assert.ok(
    !task.recovery.stack.includes('SECRETTOKEN'),
    'a token in a stack frame leaked into the task',
  );
  assert.match(task.recovery.stack, /docs\.test\/api/, 'the path is kept for diagnosis');
});

test('an existing queue resumes without repeating full directory expansion', async () => {
  const task = createTask(p),
    io = ioFor(task);
  let scans = 0;
  io.discover = async () => {
    scans++;
    return { items: links.slice(0, 2) };
  };
  const engine = new ImportEngine(task, io);
  await engine.scan();
  io.discover = async () => {
    throw new Error('a second discovery must be explicitly requested');
  };
  await engine.run();
  assert.equal(task.status, 'finished');
  assert.equal(scans, 1);
  assert.equal(Object.keys(task.pages).length, 2);
});
test('three local failures keep their evidence and do not prevent a later valid chapter', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 4) });
  const capture = io.capture;
  io.capture = async (c) =>
    c.title === 'chapter 3' ? capture(c) : { status: 'error', error: '目录路径不存在或不唯一' };
  await new ImportEngine(task, io).run();
  assert.deepEqual(
    task.queue.map((c) => c.status),
    ['failed', 'failed', 'failed', 'captured'],
  );
  assert.equal(Object.keys(task.pages).length, 1);
  assert.equal(task.status, 'paused');
  assert.equal(task.queue[0].recovery.scope, 'chapter');
});
test('a temporary chapter timeout gets one bounded retry before later chapters continue', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 4) });
  const capture = io.capture;
  const attempts = new Map();
  io.capture = async (c) => {
    const count = (attempts.get(c.title) || 0) + 1;
    attempts.set(c.title, count);
    if (c.title === 'chapter 0' || (c.title === 'chapter 1' && count === 1))
      return { status: 'error', code: 'LOAD_TIMEOUT', error: 'load timed out' };
    if (c.title === 'chapter 2') return { status: 'error', error: '未确认所选章节的正文加载完成' };
    return capture(c);
  };
  await new ImportEngine(task, io).run();
  assert.deepEqual(
    task.queue.map((c) => c.status),
    ['failed', 'captured', 'failed', 'captured'],
  );
  assert.deepEqual([...attempts.values()], [2, 2, 1, 1]);
  assert.equal(
    taskHasRetryableWork(task),
    true,
    'a later local proof failure cannot hide the earlier retryable timeout',
  );
});
for (const error of [
  new TypeError('Failed to fetch'),
  new Error('原标签页已离开手册网站'),
  new Error('Cannot access contents of url. Extension manifest must request permission.'),
  new Error('任务已更新，保存发生冲突'),
  new Error('任务已删除，请重新选择'),
])
  test('global failure stops before opening another chapter: ' + error.message, async () => {
    const task = createTask(p),
      io = ioFor(task);
    io.discover = async () => ({ items: links.slice(0, 4) });
    let calls = 0;
    io.capture = async () => {
      calls++;
      throw error;
    };
    await new ImportEngine(task, io).run();
    assert.equal(calls, 1);
    assert.deepEqual(
      task.queue.map((c) => c.status),
      ['failed', 'pending', 'pending', 'pending'],
    );
    assert.equal(task.recovery.scope, 'task');
  });
test('failed recapture storage restores the previously saved page', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 1) });
  await new ImportEngine(task, io).run();
  const key = task.queue[0].key,
    old = JSON.stringify(task.pages[key]);
  task.queue[0].status = 'pending';
  io.capture = async (c) => ({
    status: 'ok',
    url: c.url,
    text: 'replacement',
    navigationProof: { verified: true },
  });
  io.save = async (_task, pageKey) => {
    if (pageKey) throw new Error('QuotaExceededError');
  };
  await new ImportEngine(task, io).run();
  assert.equal(JSON.stringify(task.pages[key]), old);
  assert.equal(task.queue[0].status, 'failed');
  assert.equal(task.recovery.reason, 'storage');
});

test('a metadata checkpoint failure is storage trouble even when its message resembles network failure', async () => {
  const task = createTask(p),
    io = ioFor(task);
  new ImportEngine(task, io).merge(links.slice(0, 2));
  let saves = 0,
    captures = 0;
  io.save = async () => {
    if (++saves === 2) throw new Error('Failed to fetch');
  };
  io.capture = async () => {
    captures++;
    throw new Error('must not capture without durable state');
  };
  await assert.rejects(new ImportEngine(task, io).run(), /Failed to fetch/);
  assert.equal(captures, 0);
  assert.equal(task.recovery.reason, 'storage');
  assert.equal(taskHasRetryableWork(task), false);
});

test('recording one selected chapter preserves the full queue and other saved pages', async () => {
  const task = createTask(p),
    io = ioFor(task);
  io.discover = async () => ({ items: links.slice(0, 3) });
  await new ImportEngine(task, io).run();
  const saved = JSON.stringify(task.pages[task.queue[0].key]);
  task.queue[2].status = 'pending';
  const target = task.queue[1].key;
  io.discover = async () => {
    throw new Error('single-chapter recording must not scan');
  };
  const opened = [];
  io.capture = async (c) => {
    opened.push(c.key);
    return { status: 'ok', text: 'new selected body', navigationProof: { verified: true } };
  };
  await new ImportEngine(task, io).run({ chapterKey: target });
  assert.deepEqual(opened, [target]);
  assert.equal(task.queue.length, 3);
  assert.equal(task.queue[2].status, 'pending');
  assert.equal(task.pages[target].text, 'new selected body');
  assert.equal(JSON.stringify(task.pages[task.queue[0].key]), saved);
});
