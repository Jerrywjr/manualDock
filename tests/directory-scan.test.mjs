import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const [adapterSource, treeSource] = await Promise.all(
  ['manual-adapters.js', 'tree.js'].map((name) =>
    fs.readFile(new URL('../extension/' + name, import.meta.url), 'utf8'),
  ),
);
const leaf = (id, title = 'Chapter ' + id) =>
  `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item${id}"><span>${title}</span></div><ul class="x-tree-node-ct"></ul></li>`;
const branch = (id, contents = '') =>
  `<li class="x-tree-node"><div class="x-tree-node-el"><img id="branch-${id}" class="x-tree-ec-icon tree-has-child"><span>Group ${id}</span></div><ul id="children-${id}" class="x-tree-node-ct" style="display:none">${contents}</ul></li>`;
function setup(t, contents, pathname = '/cdocs.php') {
  const url = 'https://example.test' + pathname;
  const dom = new JSDOM(
    `<ul id="toc" class="x-tree-root-ct">${contents}</ul><div id="articleContent"><p>Current chapter</p><button>Execute</button></div>`,
    { url, runScripts: 'outside-only' },
  );
  const w = dom.window;
  t.after(() => w.close());
  w.HTMLElement.prototype.getClientRects = () => [{}];
  w.eval(treeSource);
  w.eval(adapterSource);
  const clicks = [];
  w.document.addEventListener('click', (event) =>
    clicks.push(event.target.id || event.target.tagName),
  );
  return {
    w,
    doc: w.document,
    api: w.SecurityManualAdapters,
    clicks,
    url,
    profile: {
      schemaVersion: 1,
      id: 'fixture',
      revision: 1,
      name: '447 chapter fixture',
      adapterId: 'sangfor',
      entry: url,
      origin: new URL(url).origin,
      pathPrefix: pathname,
      hashMode: 'none',
      queryKeys: ['index', 'dataID'],
      tocSelector: '#toc',
      contentSelector: '#articleContent',
      navigation: 'click',
      samples: [],
    },
  };
}
function installClock(w) {
  let now = 0,
    sequence = 0;
  const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (callback, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  return async (work) => {
    let settled = false,
      result,
      failure;
    work.then(
      (value) => {
        result = value;
        settled = true;
      },
      (error) => {
        failure = error;
        settled = true;
      },
    );
    for (let steps = 0; !settled && steps < 1000; steps++) {
      for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve();
      if (settled) break;
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'unfinished discovery must have a bounded loading timer');
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }
    assert.equal(settled, true, 'discovery must complete within the timer bound');
    if (failure) throw failure;
    assert.equal(timers.size, 0, 'discovery must clean up its loading timers');
    return { result, simulatedWaitMs: now };
  };
}
const loaded447 = () =>
  Array.from({ length: 3 }, (_, group) =>
    branch(group, Array.from({ length: 149 }, (_, index) => leaf(group * 149 + index)).join('')),
  ).join('');

for (const pathname of ['/adocs.php', '/cdocs.php'])
  test(`a loaded collapsed 447-chapter ${pathname} directory is scanned without expansion clicks or waits`, async (t) => {
    const p = setup(t, loaded447(), pathname);
    for (const control of p.doc.querySelectorAll('.tree-has-child'))
      control.onclick = () => {
        control.parentElement.nextElementSibling.style.display = 'block';
      };
    const started = performance.now();
    const result = await p.api.discover({ profile: p.profile });
    const elapsedMs = performance.now() - started;
    console.log(
      JSON.stringify({
        fixture: 'loaded-collapsed-447',
        pathname,
        elapsedMs: Math.round(elapsedMs),
        clicks: p.clicks.length,
        chapters: result.items.length,
        expanded: result.diagnostics.expanded,
      }),
    );
    assert.equal(result.items.length, 447);
    assert.equal(new Set(result.items.map((chapter) => chapter.key)).size, 447);
    assert.equal(result.diagnostics.pendingBranches, 0);
    assert.equal(result.diagnostics.truncated, false);
    assert.deepEqual(p.clicks, [], 'loaded hidden chapters need no page-side expansion');
    assert.equal(result.diagnostics.expanded, 0);
    assert.equal(result.diagnostics.expansionLimited, false);
    assert.ok(elapsedMs < 2000, `static 447-chapter discovery took ${Math.round(elapsedMs)}ms`);
    assert.equal(p.doc.querySelector('#children-0').style.display, 'none');
  });

test('known Ext detection does not inspect every chapter with generic link heuristics', (t) => {
  const p = setup(t, loaded447());
  let chapterProbes = 0;
  const original = p.w.Element.prototype.querySelector;
  p.w.Element.prototype.querySelector = function (selector) {
    if (this.matches('li.x-tree-node')) chapterProbes++;
    return original.call(this, selector);
  };
  const { profile } = p.api.detect({ entry: p.url });
  assert.equal(profile.adapterId, 'sangfor');
  assert.equal(profile.navigation, 'click');
  assert.deepEqual(Array.from(profile.queryKeys), ['index', 'dataID']);
  assert.equal(profile.contentSelector, '#articleContent');
  assert.equal(chapterProbes, 0, 'the known adapter does not need generic per-chapter inference');
  assert.deepEqual(p.clicks, []);
});

test('asynchronous Ext child branches are still expanded and scanned after their nodes arrive', async (t) => {
  const p = setup(t, branch(0));
  const finish = installClock(p.w);
  p.doc.querySelector('#branch-0').onclick = () => {
    p.w.setTimeout(() => {
      p.doc.querySelector('#children-0').innerHTML = branch(1);
      p.doc.querySelector('#branch-1').onclick = () => {
        p.w.setTimeout(() => {
          p.doc.querySelector('#children-1').innerHTML = leaf(447);
        }, 50);
      };
    }, 1800);
  };
  const { result, simulatedWaitMs } = await finish(p.api.discover({ profile: p.profile }));
  assert.equal(result.items.length, 1);
  assert.deepEqual(Array.from(result.items[0].locator.path), ['Group 0', 'Group 1', 'Chapter 447']);
  assert.deepEqual(p.clicks, ['branch-0', 'branch-1']);
  assert.equal(result.diagnostics.pendingBranches, 0);
  assert.equal(result.diagnostics.expansionLimited, false);
  assert.ok(simulatedWaitMs >= 1850, 'must wait for both actual asynchronous child insertions');
  assert.ok(simulatedWaitMs < 3000, 'completed Ext loads must not consume the six-second timeout');
});

test('an unresponsive Ext branch remains incomplete after its bounded loading wait', async (t) => {
  const p = setup(t, branch(0));
  const finish = installClock(p.w);
  const { result, simulatedWaitMs } = await finish(p.api.discover({ profile: p.profile }));
  assert.equal(simulatedWaitMs, 6000);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.pendingBranches, 1);
  assert.deepEqual(p.clicks, ['branch-0']);
  assert.ok(result.warnings.some((warning) => /尚未加载|展开后重新扫描/.test(warning)));
});

test('loaded-tree optimization preserves duplicate exclusions and incomplete-node diagnostics', async (t) => {
  const p = setup(
    t,
    branch(
      0,
      leaf(1, 'Duplicate') +
        leaf(2, 'Duplicate') +
        '<li class="x-tree-node"><span>Malformed</span></li>',
    ),
  );
  const finish = installClock(p.w);
  const { result } = await finish(p.api.discover({ profile: p.profile }));
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.ambiguousPaths, 1);
  assert.equal(result.diagnostics.incompleteNodes, 1);
  assert.ok(result.warnings.some((warning) => /重复/.test(warning)));
  assert.ok(result.warnings.some((warning) => /结构不完整/.test(warning)));
  assert.deepEqual(p.clicks, []);
});

for (const duplicateId of ['one', 'two'])
  test(`generic verification rejects an ambiguous path even when its duplicate has id ${duplicateId}`, async (t) => {
    const p = setup(
      t,
      `<li><button id="one" aria-selected="true">One</button></li><li><button id="${duplicateId}">One</button></li>`,
      '/docs/',
    );
    const profile = { ...p.profile, adapterId: 'generic' };
    const chapter = {
      url: profile.entry,
      title: 'One',
      locator: { kind: 'generic-toc', path: ['One'], nodeId: 'one' },
    };
    const directory = await p.api.discover({ profile, expand: false });
    assert.equal(directory.items.length, 0);
    assert.equal(directory.diagnostics.ambiguousPaths, 1);
    assert.equal(p.api.verify({ profile, chapter }).verified, false);
    assert.deepEqual(p.clicks, []);
  });

test('generic verification rejects a path made ambiguous after a successful directory scan', async (t) => {
  const p = setup(t, '<li><button id="one" aria-selected="true">One</button></li>', '/docs/');
  const profile = { ...p.profile, adapterId: 'generic' };
  const directory = await p.api.discover({ profile, expand: false });
  assert.equal(directory.items.length, 1);
  const chapter = directory.items[0];
  assert.equal(p.api.verify({ profile, chapter }).verified, true);
  p.doc
    .querySelector('#toc')
    .insertAdjacentHTML('beforeend', '<li><button id="two">One</button></li>');
  assert.equal(
    p.api.verify({ profile, chapter }).verified,
    false,
    'proof must reflect the current DOM without requiring another discovery',
  );
  assert.deepEqual(p.clicks, []);
});

for (const shape of ['anchor-label', 'explicit-leaf-without-child-list'])
  test(`Ext ${shape} keeps chapter identity through discovery, opening and verification`, async (t) => {
    const label =
      shape === 'anchor-label'
        ? '<a class="x-tree-node-anchor" href="#"><span id="chapter-label">One</span></a>'
        : '<span id="chapter-label">One</span>';
    const childList = shape === 'anchor-label' ? '<ul class="x-tree-node-ct"></ul>' : '';
    const p = setup(
      t,
      branch(
        0,
        `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf" ext:tree-node-id="api-menu-item1">${label}</div>${childList}</li>`,
      ),
      '/adocs.php',
    );
    p.doc.querySelector('#children-0').style.display = 'block';
    const { profile } = p.api.detect({ entry: p.url });
    const discovered = await p.api.discover({ profile, expand: false });
    assert.equal(discovered.items.length, 1);
    const chapter = discovered.items[0];
    assert.deepEqual(Array.from(chapter.locator.path), ['Group 0', 'One']);
    assert.equal(discovered.diagnostics.incompleteNodes, 0);
    const row = p.doc.querySelector('#chapter-label').closest('.x-tree-node-el');
    p.doc.querySelector(
      shape === 'anchor-label' ? '.x-tree-node-anchor' : '#chapter-label',
    ).onclick = (event) => {
      event.preventDefault();
      row.classList.add('x-tree-selected');
    };
    assert.equal(p.api.verify({ profile, chapter }).verified, false);
    assert.equal(p.api.open({ profile, chapter }).clicked, true);
    assert.equal(p.api.verify({ profile, chapter }).verified, true);
    assert.equal(p.api.current({ profile }).chapter.title, 'One');
  });

test('Ext leaf variants still reject ambiguous labels, missing leaf proof and pending children', async (t) => {
  const p = setup(
    t,
    '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><a class="x-tree-node-anchor" href="#"><span>One</span></a><a class="x-tree-node-anchor" href="#"><span>Other</span></a></div><ul class="x-tree-node-ct"></ul></li>' +
      '<li class="x-tree-node"><div class="x-tree-node-el"><span>No leaf proof</span></div></li>' +
      '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><img class="x-tree-ec-icon tree-has-child"><span>Pending</span></div></li>' +
      '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><span>Malformed children</span></div><ol><li class="x-tree-node"><span>Child</span></li></ol></li>',
  );
  const result = await p.api.discover({ profile: p.profile, expand: false });
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.pendingBranches, 1);
  assert.ok(result.diagnostics.incompleteNodes >= 3);
  assert.deepEqual(p.clicks, []);
});

test('an Ext anchor label cannot navigate outside the confirmed manual route', async (t) => {
  const p = setup(
    t,
    '<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><a id="unsafe-label" class="x-tree-node-anchor" href="/framework.php"><span>One</span></a></div><ul class="x-tree-node-ct"></ul></li>',
    '/adocs.php',
  );
  p.doc.querySelector('#unsafe-label').onclick = (event) => event.preventDefault();
  const result = await p.api.discover({ profile: p.profile, expand: false });
  assert.equal(result.items.length, 1);
  assert.equal(p.api.open({ profile: p.profile, chapter: result.items[0] }).clicked, false);
  assert.deepEqual(p.clicks, []);
});

for (const attributes of [
  'target="_blank"',
  'target="another-page"',
  'target="_top"',
  'download',
  'base-target',
  'base-href',
])
  test(`an Ext anchor cannot leave source control through ${attributes}`, async (t) => {
    const p = setup(
      t,
      `<li class="x-tree-node"><div class="x-tree-node-el x-tree-node-leaf"><a id="external-context" class="x-tree-node-anchor" href="/adocs.php?index=0&dataID=api-menu-item2" ${attributes.startsWith('base-') ? '' : attributes}><span>One</span></a></div><ul class="x-tree-node-ct"></ul></li>`,
      '/adocs.php',
    );
    if (attributes.startsWith('base-')) {
      const base = p.doc.createElement('base');
      if (attributes === 'base-target') base.target = '_blank';
      else base.href = 'https://outside.test/';
      p.doc.head.append(base);
    }
    p.doc.querySelector('#external-context').onclick = (event) => event.preventDefault();
    const result = await p.api.discover({ profile: p.profile, expand: false });
    assert.equal(result.items.length, 1);
    assert.equal(p.api.open({ profile: p.profile, chapter: result.items[0] }).clicked, false);
    assert.deepEqual(p.clicks, []);
  });

function scopedTrees(t, html) {
  const p = setup(t, '', '/adocs.php');
  p.doc.querySelector('#toc').outerHTML = html;
  return { ...p, tree: p.w.SangforTree };
}
const rootHTML = (id, contents) => `<ul id="${id}" class="x-tree-root-ct">${contents}</ul>`;

for (const tocSelector of ['#manual-trees', '#manual-trees > .x-tree-root-ct'])
  test(`explicit Ext root scope ${tocSelector} preserves all five roots through scan, current, open and verify`, (t) => {
    const p = scopedTrees(
      t,
      '<section id="manual-trees">' +
        Array.from({ length: 5 }, (_, i) => rootHTML('root-' + i, leaf(i))).join('') +
        '</section>' +
        rootHTML('outside', leaf(99)),
    );
    const options = { entry: p.url, tocSelector };
    const result = p.tree.scan(options);
    assert.deepEqual(
      Array.from(result.items, (item) => item.title),
      ['Chapter 0', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4'],
    );
    assert.equal(result.diagnostics.roots, 5);
    const chapter = result.items[4];
    p.doc.querySelector('#root-4 span').onclick = (event) => {
      event.target.closest('.x-tree-node-el').classList.add('x-tree-selected');
    };
    assert.equal(p.tree.open({ ...options, locator: chapter.locator }).clicked, true);
    assert.equal(p.tree.current(options).chapter.title, 'Chapter 4');
    assert.equal(p.tree.verify({ ...options, locator: chapter.locator }).verified, true);
    assert.deepEqual(p.clicks, ['SPAN']);
  });

for (const outside of [
  { id: 2, title: 'Chosen' },
  { id: 1, title: 'Outside' },
])
  test(`explicit Ext root scope rejects an outside selected node ${outside.id}/${outside.title}`, (t) => {
    const p = scopedTrees(
      t,
      '<section id="manual-trees">' +
        rootHTML('inside', leaf(1, 'Chosen')) +
        '</section>' +
        rootHTML('outside', leaf(outside.id, outside.title)),
    );
    const options = { entry: p.url, tocSelector: '#manual-trees' };
    p.doc.querySelector('#outside .x-tree-node-el').classList.add('x-tree-selected');
    const locator = {
      kind: 'sangfor-ext-tree',
      path: [outside.title],
      nodeId: 'api-menu-item' + outside.id,
    };
    assert.deepEqual(
      Array.from(p.tree.scan(options).items, (item) => item.title),
      ['Chosen'],
    );
    assert.equal(p.tree.open({ ...options, locator }).clicked, false);
    assert.equal(p.tree.verify({ ...options, locator }).verified, false);
    assert.equal(p.tree.current(options).status, 'error');
    assert.deepEqual(p.clicks, []);
    p.doc.querySelector('#inside .x-tree-node-el').classList.add('x-tree-selected');
    const inside = { kind: 'sangfor-ext-tree', path: ['Chosen'], nodeId: 'api-menu-item1' };
    assert.equal(p.tree.verify({ ...options, locator: inside }).verified, true);
    assert.equal(p.tree.current(options).chapter.title, 'Chosen');
  });

test('explicit Ext root scope rejects duplicate paths across roots even with unique node ids', (t) => {
  const p = scopedTrees(
    t,
    rootHTML('one', leaf(1, 'Duplicate')) + rootHTML('two', leaf(2, 'Duplicate')),
  );
  p.doc.querySelector('#two .x-tree-node-el').classList.add('x-tree-selected');
  const options = { entry: p.url, tocSelector: '.x-tree-root-ct' };
  const locator = { kind: 'sangfor-ext-tree', path: ['Duplicate'], nodeId: 'api-menu-item2' };
  assert.equal(p.tree.scan(options).diagnostics.ambiguousPaths, 1);
  assert.equal(p.tree.open({ ...options, locator }).clicked, false);
  assert.equal(p.tree.verify({ ...options, locator }).verified, false);
  assert.equal(p.tree.current(options).status, 'error');
  assert.deepEqual(p.clicks, []);
});

test('explicit Ext root scope filters nested and excluded roots consistently', (t) => {
  const p = scopedTrees(
    t,
    '<section id="manual-trees">' +
      rootHTML('inside', leaf(1) + rootHTML('nested', leaf(2))) +
      '<form>' +
      rootHTML('excluded', leaf(3)) +
      '</form></section>',
  );
  const options = { entry: p.url, tocSelector: '.x-tree-root-ct' };
  assert.deepEqual(
    Array.from(p.tree.directoryRoots(options), (root) => root.id),
    ['inside'],
  );
  assert.deepEqual(
    Array.from(p.tree.scan(options).items, (item) => item.title),
    ['Chapter 1'],
  );
});

for (const tocSelector of [
  '',
  '#missing',
  '[',
  'body',
  'html',
  '#manual-trees, #other-directory',
  '#articleContent',
])
  test(`explicit Ext root scope ${JSON.stringify(tocSelector)} never falls back to the document`, (t) => {
    const p = scopedTrees(
      t,
      '<section id="manual-trees">' +
        rootHTML('inside', leaf(1)) +
        '</section><nav id="other-directory"></nav>',
    );
    const options = { entry: p.url, tocSelector };
    const locator = { kind: 'sangfor-ext-tree', path: ['Chapter 1'], nodeId: 'api-menu-item1' };
    p.doc.querySelector('#inside .x-tree-node-el').classList.add('x-tree-selected');
    assert.throws(() => p.tree.directoryRoots(options), /目录|校准/);
    assert.equal(p.tree.scan(options).items.length, 0);
    assert.equal(p.tree.open({ ...options, locator }).clicked, false);
    assert.equal(p.tree.current(options).status, 'error');
    assert.equal(p.tree.verify({ ...options, locator }).verified, false);
    assert.deepEqual(p.clicks, []);
  });

test('explicit Ext root scope is resolved again after opening a branch rebuilds the tree', (t) => {
  const p = scopedTrees(
    t,
    '<section id="manual-trees">' + rootHTML('inside', branch(0, leaf(1))) + '</section>',
  );
  const options = { entry: p.url, tocSelector: '#manual-trees' };
  const chapter = p.tree.scan(options).items[0];
  p.doc.querySelector('#branch-0').onclick = () => {
    p.doc.body.append(p.doc.querySelector('#inside'));
  };
  assert.equal(p.tree.open({ ...options, locator: chapter.locator }).clicked, false);
  assert.deepEqual(
    p.clicks,
    ['branch-0'],
    'a moved-out chapter must not be clicked after branch expansion',
  );
});

test('single-root verification refuses duplicate paths with distinct node ids', (t) => {
  const p = scopedTrees(t, rootHTML('inside', leaf(1, 'Duplicate') + leaf(2, 'Duplicate')));
  p.doc.querySelectorAll('#inside .x-tree-node-el')[1].classList.add('x-tree-selected');
  const options = { entry: p.url, tocSelector: '#inside' };
  const locator = { kind: 'sangfor-ext-tree', path: ['Duplicate'], nodeId: 'api-menu-item2' };
  const discovered = p.tree.scan(options);
  assert.equal(discovered.items.length, 0);
  assert.equal(discovered.diagnostics.ambiguousPaths, 1);
  assert.equal(p.tree.verify({ ...options, locator }).verified, false);
});

for (const change of ['insert', 'rename'])
  test(`single-root verification rejects a duplicate introduced by synchronous ${change}`, (t) => {
    const p = scopedTrees(t, rootHTML('inside', branch(0, leaf(1, 'Chosen') + leaf(2, 'Other'))));
    const options = { entry: p.url, tocSelector: '#inside' };
    const chosen = p.doc.querySelector('[ext\\:tree-node-id="api-menu-item1"]');
    chosen.classList.add('x-tree-selected');
    const locator = {
      kind: 'sangfor-ext-tree',
      path: ['Group 0', 'Chosen'],
      nodeId: 'api-menu-item1',
    };
    assert.equal(p.tree.verify({ ...options, locator }).verified, true);
    if (change === 'insert')
      p.doc.querySelector('#children-0').insertAdjacentHTML('beforeend', leaf(3, 'Chosen'));
    else
      p.doc.querySelector('[ext\\:tree-node-id="api-menu-item2"] span').firstChild.nodeValue =
        'Chosen';
    assert.equal(p.tree.verify({ ...options, locator }).verified, false);
    assert.equal(p.tree.scan(options).diagnostics.ambiguousPaths, 1);
    assert.deepEqual(p.clicks, []);
  });

// Structure reported by the user from the authenticated API page on 2026-10-14:
// one UL navigation tree and four DIV parameter grids reuse x-tree-root-ct.
const parameterGrid = (contents = '') =>
  `<div class="x-panel af-api-listviewgrid x-treegrid"><div class="x-panel-bwrap"><div class="x-panel-body x-panel-body-noheader"><div class="x-tree-root-ct x-treegrid-ct x-tree-arrows"><div class="x-grid3-header">Parameter</div><div class="x-treegrid-root-node">${contents}</div></div></div></div></div>`;

test('legacy Ext root binding separates the observed API parameter grids from navigation', (t) => {
  const p = scopedTrees(
    t,
    '<div class="af-api-menutree x-border-layout-ct"><div class="af-api-menutree-scroll x-border-panel"><div>' +
      rootHTML('directory', leaf(1, '2.1 用户登录') + leaf(2, '2.2 用户注销')) +
      '</div></div></div>',
  );
  p.doc.querySelector('#articleContent').innerHTML =
    parameterGrid() +
    parameterGrid() +
    parameterGrid() +
    parameterGrid(
      '<div class="x-tree-node-el x-tree-selected">code</div><div class="x-tree-node-el">data</div>',
    );
  const options = { entry: p.url, tocSelector: '.x-tree-root-ct' };
  const scan = p.tree.scan(options);
  assert.equal(scan.status, undefined);
  assert.equal(scan.diagnostics.roots, 1);
  assert.deepEqual(
    Array.from(scan.items, (item) => item.title),
    ['2.1 用户登录', '2.2 用户注销'],
  );
  p.doc.querySelector('#directory span').onclick = (event) =>
    event.target.parentElement.classList.add('x-tree-selected');
  assert.equal(p.tree.open({ ...options, locator: scan.items[0].locator }).clicked, true);
  assert.equal(p.tree.verify({ ...options, locator: scan.items[0].locator }).verified, true);
  assert.equal(p.tree.current(options).chapter.title, '2.1 用户登录');
  assert.deepEqual(p.clicks, ['SPAN']);
});

test('a parameter grid containing chapter-like UL nodes cannot become a directory', (t) => {
  const p = scopedTrees(
    t,
    rootHTML('directory', leaf(1)) + parameterGrid(rootHTML('fake-directory', leaf(99))),
  );
  const scan = p.tree.scan({ entry: p.url, tocSelector: '.x-tree-root-ct' });
  assert.deepEqual(
    Array.from(scan.items, (item) => item.title),
    ['Chapter 1'],
  );
  assert.throws(() => p.tree.directoryRoots({ tocSelector: '#fake-directory' }), /目录|校准/);
});

test('an ordinary DIV sharing the Ext class remains an explicit ambiguity', (t) => {
  const p = scopedTrees(
    t,
    rootHTML('directory', leaf(1)) + '<div class="x-tree-root-ct">Unknown region</div>',
  );
  assert.throws(() => p.tree.directoryRoots({ tocSelector: '.x-tree-root-ct' }), /多个普通区域/);
});
