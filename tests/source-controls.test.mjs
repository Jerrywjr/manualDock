import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
let setupSourceControls;
try {
  ({ setupSourceControls } = await import('../extension/source-controls.js'));
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const flush = async () => {
  for (let n = 0; n < 12; n++) await new Promise((r) => setImmediate(r));
};
function fixture(t, { deny = false, view = 'rotation', loadedURL } = {}) {
  const dom = new JSDOM(
    '<form id="source-connect-form"><input id="source-url"><button id="source-connect">连接页面</button></form><select id="source-select"></select><p id="source-connect-status"></p>',
  );
  t.after(() => dom.window.close());
  let selected = null;
  const sessions = [],
    calls = [],
    errors = [];
  assert.equal(typeof setupSourceControls, 'function');
  const ui = setupSourceControls({
    document: dom.window.document,
    getController: () => ({
      listSessions: () => sessions,
      canAddSource: () => true,
      addSource: async (id, { purpose }) => {
        calls.push(['add', id, purpose]);
        const session = {
          tabId: id,
          purpose,
          getState: () => ({
            address: 'https://manual.test/docs',
            product: 'Source',
            closed: false,
          }),
        };
        sessions.push(session);
        return session;
      },
    }),
    getSelected: () => selected,
    getView: () => view,
    connectURL: (raw) => {
      calls.push(['connect', raw]);
      return deny
        ? Promise.reject(new Error('未授权'))
        : Promise.resolve({ id: 7, url: loadedURL || raw });
    },
    onSelect: async (session, options) => calls.push(['select', session.tabId, options.view]),
    onError: (e) => errors.push(e.message),
  });
  return {
    dom,
    ui,
    calls,
    errors,
    sessions,
    setSelected: (session) => {
      selected = session;
      ui.refresh();
    },
    setView: (value) => {
      view = value;
      ui.refresh();
    },
  };
}
test('the URL form connects and selects its target while preserving the rotation view', async (t) => {
  const p = fixture(t),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/docs';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  assert.deepEqual(p.calls[0], ['connect', 'https://manual.test/docs']);
  await flush();
  assert.deepEqual(p.calls, [
    ['connect', 'https://manual.test/docs'],
    ['add', 7, 'rotation'],
    ['select', 7, 'rotation'],
  ]);
  assert.match(d.getElementById('source-connect-status').textContent, /已连接/);
  assert.equal(d.getElementById('source-connect').disabled, false);
});
test('denied URL connection leaves sources unchanged and allows a retry', async (t) => {
  const p = fixture(t, { deny: true }),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/docs';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.errors, ['未授权']);
  assert.equal(d.getElementById('source-connect').disabled, false);
});

test('connecting from collection settings registers a document without starting recognition', async (t) => {
  const p = fixture(t, { view: 'web' }),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/docs';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.deepEqual(p.calls.at(-1), ['select', 7, 'web']);
  assert.deepEqual(p.calls[1], ['add', 7, 'document']);
});

test('switching from menu to document workspace sets the connection purpose without a second selector', async (t) => {
  const p = fixture(t),
    d = p.dom.window.document;
  p.setView('web');
  assert.equal(d.getElementById('source-purpose'), null);
  assert.equal(d.getElementById('source-connect').textContent, '连接文档页');
  d.getElementById('source-url').value = 'https://manual.test/docs';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.deepEqual(p.calls[1], ['add', 7, 'document']);
  assert.deepEqual(p.calls.at(-1), ['select', 7, 'web']);
});

test('the document selector excludes management pages while retaining their connection', async (t) => {
  const p = fixture(t),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/framework.php';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.equal(d.getElementById('source-select').options.length, 2);
  p.setView('web');
  assert.equal(d.getElementById('source-select').options.length, 1);
  p.setView('rotation');
  assert.equal(d.getElementById('source-select').options.length, 2);
});

for (const path of ['adocs.php', 'cdocs.php?index=0&dataID=api-menu-item28'])
  test(`pasting ${path} in the default menu view connects a document and opens recognition`, async (t) => {
    const p = fixture(t),
      d = p.dom.window.document;
    d.getElementById('source-url').value = 'https://manual.test/' + path;
    d.getElementById('source-connect-form').dispatchEvent(
      new p.dom.window.Event('submit', { cancelable: true }),
    );
    assert.equal(p.calls[0][0], 'connect', 'the connection starts within the submit gesture');
    await flush();
    assert.deepEqual(p.calls[1], ['add', 7, 'document']);
    assert.deepEqual(p.calls.at(-1), ['select', 7, 'web']);
    assert.match(d.getElementById('source-connect-status').textContent, /文档已连接/);
  });

test('the loaded management URL takes precedence over a document purpose selection', async (t) => {
  const p = fixture(t, {
      view: 'web',
      loadedURL: 'https://manual.test/framework.php#/mod_home/index',
    }),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/entry';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.deepEqual(p.calls[1], ['add', 7, 'rotation']);
  assert.deepEqual(p.calls.at(-1), ['select', 7, 'rotation']);
});

test('a known document URL redirected to same-origin login retains its document purpose without scanning', async (t) => {
  const p = fixture(t, { loadedURL: 'https://manual.test/login' }),
    d = p.dom.window.document;
  d.getElementById('source-url').value = 'https://manual.test/cdocs.php';
  d.getElementById('source-connect-form').dispatchEvent(
    new p.dom.window.Event('submit', { cancelable: true }),
  );
  await flush();
  assert.deepEqual(p.calls[1], ['add', 7, 'document']);
  assert.deepEqual(p.calls.at(-1), ['select', 7, 'web']);
});

test('typing a known document address explains automatic routing without connecting or changing an unknown-page choice', (t) => {
  const p = fixture(t),
    d = p.dom.window.document;
  assert.match(d.getElementById('source-url').placeholder, /页面/);
  d.getElementById('source-url').value = 'https://manual.test/adocs.php';
  d.getElementById('source-url').dispatchEvent(new p.dom.window.Event('input'));
  assert.match(d.getElementById('source-connect-status').textContent, /文档地址.*识别与校准/);
  assert.equal(d.getElementById('source-connect').textContent, '连接文档页');
  d.getElementById('source-url').value = 'https://manual.test/unknown';
  d.getElementById('source-url').dispatchEvent(new p.dom.window.Event('input'));
  assert.match(d.getElementById('source-connect-status').textContent, /当前栏目.*菜单轮换/);
  assert.equal(d.getElementById('source-connect').textContent, '连接管理页');
  assert.deepEqual(p.calls, []);
});

for (const [condition, purpose, label, disabled] of [
  ['closed', 'rotation', '已关闭', false],
  ['closed', 'document', '已关闭', true],
  ['disposed', 'rotation', '已移除', true],
  ['disposed', 'document', '已移除', true],
])
  test(`the selected ${condition} ${purpose} source shows its availability without selecting another page`, async (t) => {
    const p = fixture(t, { view: purpose === 'rotation' ? 'rotation' : 'web' }),
      d = p.dom.window.document;
    const source = (tabId) => ({
      tabId,
      purpose,
      getState: () => ({
        product: 'SANGFOR IPS',
        address: 'https://manual.test/framework.php',
      }),
    });
    const selected = source(7),
      replacement = source(8);
    p.sessions.push(selected, replacement);
    p.setSelected(selected);
    const select = d.getElementById('source-select');
    assert.equal(select.value, '7');
    assert.doesNotMatch(select.selectedOptions[0].textContent, /已关闭|已移除/);
    selected[condition] = true;
    p.ui.refresh();
    assert.equal(select.value, '7', 'the dropdown continues to represent the actual binding');
    assert.match(select.selectedOptions[0].textContent, new RegExp(label));
    assert.equal(select.selectedOptions[0].disabled, disabled);
    assert.equal(select.options[2].disabled, false);
    assert.deepEqual(p.calls, [], 'refresh must not bind a different source');
    if (!disabled) {
      p.setSelected(replacement);
      select.value = '7';
      select.dispatchEvent(new p.dom.window.Event('change'));
      await flush();
      assert.deepEqual(p.calls, [['select', 7, 'rotation']]);
      p.calls.length = 0;
      p.setSelected(selected);
    }
    p.sessions.splice(0, 1);
    p.ui.refresh();
    assert.equal(select.value, '', 'an absent source must not imply selection of the replacement');
    assert.deepEqual(p.calls, []);
  });
