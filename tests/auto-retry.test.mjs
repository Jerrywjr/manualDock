import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoRetryClock } from '../extension/auto-retry.js';

function setup() {
  let now = 0,
    id = 0;
  const timers = new Map(),
    calls = [];
  let task = { taskId: 'first', autoRecovery: { enabled: true, nextAttemptAt: 180000 } };
  const clock = new AutoRetryClock({
    getTask: () => task,
    retry: async (key) => calls.push(key),
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    clock,
    calls,
    timers,
    get task() {
      return task;
    },
    set task(value) {
      task = value;
    },
    advance: async (ms) => {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          await t.fn();
        }
    },
  };
}
test('automatic retry waits the full three minutes and fires once', async () => {
  const s = setup();
  s.clock.refresh();
  await s.advance(179999);
  assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.deepEqual(s.calls, ['first']);
});
test('disposing for a manual pause cancels a pending retry', async () => {
  const s = setup();
  s.clock.refresh();
  s.task.autoRecovery.enabled = false;
  s.clock.dispose();
  await s.advance(180000);
  assert.equal(s.calls.length, 0);
});
test('a queued retry never resumes a different task', async () => {
  const s = setup();
  s.clock.refresh();
  s.task = { taskId: 'second', autoRecovery: { enabled: true, nextAttemptAt: 180000 } };
  await s.advance(180000);
  assert.equal(s.calls.length, 0);
});
test('reopening honors the saved deadline and catches up after sleep', async () => {
  const s = setup();
  await s.advance(90000);
  s.clock.refresh();
  await s.advance(90000);
  assert.deepEqual(s.calls, ['first']);
  s.clock.dispose();
  await s.advance(300000);
  s.clock.refresh();
  await s.advance(1);
  assert.equal(s.calls.length, 2);
});
test('refreshing or a late cancelled callback cannot start concurrent retries', async () => {
  const s = setup();
  s.clock.refresh();
  const stale = [...s.timers.values()][0].fn;
  s.clock.refresh();
  await stale();
  assert.equal(s.calls.length, 0);
  await s.advance(180000);
  assert.equal(s.calls.length, 1);
});

test('default timers retain their browser global receiver in a service worker', (t) => {
  const oldSet = globalThis.setTimeout,
    oldClear = globalThis.clearTimeout;
  t.after(() => {
    globalThis.setTimeout = oldSet;
    globalThis.clearTimeout = oldClear;
  });
  globalThis.setTimeout = function () {
    assert.equal(this, globalThis);
    return 1;
  };
  globalThis.clearTimeout = function () {
    assert.equal(this, globalThis);
  };
  const clock = new AutoRetryClock({
    getTask: () => ({
      taskId: 'one',
      autoRecovery: { enabled: true, nextAttemptAt: Date.now() + 5000 },
    }),
    retry: async () => {},
  });
  clock.refresh();
  clock.dispose();
});
