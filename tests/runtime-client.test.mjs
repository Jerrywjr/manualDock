import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteSession } from '../extension/runtime-client.js';

test('closing a source updates the panel without racing the background pause', async (t) => {
  const previous = globalThis.chrome;
  const commands = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message) => {
        commands.push(message.action);
        return { value: null };
      },
    },
  };
  const session = createRemoteSession({ tabId: 12, io: {}, locks: {} });
  t.after(() => {
    session.dispose();
    globalThis.chrome = previous;
  });
  session.connected = true;
  session.initialized = true;
  session.profile = {};
  session.task = {
    taskId: 'saved',
    status: 'finished',
    queue: [{ key: 'one', status: 'captured' }],
    pages: { one: { text: 'Saved body', capturedAt: 'original' } },
  };
  const before = structuredClone(session.task);
  await session.close();
  assert.deepEqual(commands, [], 'background tabs.onRemoved is the only pause owner');
  assert.equal(session.getState().status, 'closed');
  assert.equal(session.getState().canStart, false);
  assert.match(session.getState().error, /已关闭/);
  assert.deepEqual(session.task, before);
});
