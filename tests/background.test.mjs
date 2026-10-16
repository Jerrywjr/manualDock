import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8').then(
  (source) => source.replace(/^import .*background-runtime.*\ncreateBackgroundRuntime.*\n/, ''),
);
function harness() {
  let click, receive;
  const opened = [],
    updates = [],
    messages = [],
    tabs = [];
  const chrome = {
    action: { onClicked: { addListener: (fn) => (click = fn) } },
    runtime: {
      id: 'test',
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener: (fn) => (receive = fn) },
      sendMessage: async (m) => {
        messages.push(m);
        return m.type === 'manualdock:locate-workspace'
          ? { workspace: tabs[0] }
          : { accepted: true };
      },
    },
    tabs: {
      query: async () => {
        throw new Error('must not enumerate tabs');
      },
      get: async (id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error('missing');
        return tab;
      },
      create: async (o) => {
        const tab = { id: 100, url: o.url };
        tabs.push(tab);
        opened.push(o);
        return tab;
      },
      update: async (id, o) => {
        updates.push({ id, ...o });
      },
    },
    windows: { update: async () => {} },
  };
  runInNewContext(source, { chrome, URL, console });
  return {
    click,
    opened,
    updates,
    messages,
    ready: () =>
      new Promise((resolve) => receive({ type: 'manualdock:ready' }, { id: 'test' }, resolve)),
  };
}
test('sequential source handoffs reuse one workspace and preserve individual tab IDs', async () => {
  const h = harness();
  await h.click({ id: 7 });
  await h.click({ id: 8 });
  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0].url, /panel.html\?tab=7/);
  assert.ok(h.messages.some((m) => m.tabId === 8));
  assert.ok(h.updates.every((t) => t.id === 100));
});
test('concurrent action clicks serialize workspace creation', async () => {
  const h = harness();
  await Promise.all([h.click({ id: 1 }), h.click({ id: 2 }), h.click({ id: 3 })]);
  assert.equal(h.opened.length, 1);
});
test('source queued before workspace load is delivered by the ready handshake', async () => {
  const h = harness();
  await h.click({ id: 7 });
  const result = await h.ready();
  assert.ok(Array.from(result.tabIds).includes(7));
});
test('no source tab id opens nothing', async () => {
  const h = harness();
  await h.click({ id: 0 });
  await h.click({});
  assert.equal(h.opened.length, 0);
});
