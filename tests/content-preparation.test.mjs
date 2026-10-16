import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserIO } from '../extension/browser-io.js';

const profile = {
  schemaVersion: 1,
  id: 'content-preparation',
  revision: 1,
  adapterId: 'generic',
  entry: 'https://manual.test/docs/start',
  origin: 'https://manual.test',
  pathPrefix: '/docs',
  queryKeys: [],
  hashMode: 'none',
  tocSelector: '#toc',
  contentSelector: 'main',
  navigation: 'click',
  samples: [],
};
const chapter = {
  key: 'toc:chapter-b',
  url: profile.entry,
  title: 'Chapter B',
  locator: { kind: 'generic-toc', path: ['Chapter B'] },
};

// Exercise the real IO controller with a virtual clock and page-side replies.
// This fixture represents asynchronous DOM states, not a real device capture.
function pageBoundary(t, { bodyAt = 0, expansionMs = 0, preparation = 'ok' } = {}) {
  const previous = {
    chrome: globalThis.chrome,
    setTimeout: globalThis.setTimeout,
    now: Date.now,
  };
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.now;
  });
  let now = 0,
    opened = false,
    preparedAt = null;
  const events = [];
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms) => {
    queueMicrotask(() => {
      now += ms;
      callback();
    });
    return 1;
  };
  const body = () => {
    if (!opened || now < bodyAt) return 'Chapter A old body';
    if (preparedAt === null) return 'Chapter B summary';
    if (now < preparedAt + expansionMs) return 'Chapter B loading example';
    return 'Chapter B summary\nrequest: GET /example\nresponse: {"code":0}';
  };
  const state = () => ({
    documentId: preparedAt !== null && preparation === 'document-change' ? 'replaced' : 'same',
    documentURL: profile.entry,
    body: {
      signature: body(),
      auth: false,
      nonEmpty: true,
      loading: preparedAt !== null && now < preparedAt + expansionMs,
    },
    // A tree can select B while its old A body remains on screen.
    proof: {
      verified: opened && !(preparedAt !== null && preparation === 'proof-change'),
      kind: 'generic-toc',
    },
  });
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: profile.entry, status: 'complete' }),
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) return [];
        if (options.args?.length === 0) return [{ result: '' }];
        if (options.args?.[0] === 'open') {
          opened = true;
          return [{ result: { clicked: true } }];
        }
        const source = options.func.toString();
        if (source.includes('.prepareContent(')) {
          const [input] = options.args;
          assert.equal(options.args.length, 1);
          assert.equal(input.selector, 'main');
          assert.equal(input.profile.entry, profile.entry);
          assert.equal(input.chapter.key, chapter.key);
          assert.deepEqual(input.locator, chapter.locator);
          events.push({ kind: 'prepare', at: now, before: state() });
          preparedAt = now;
          return [
            {
              result:
                preparation === 'error'
                  ? {
                      status: 'error',
                      error: '正文参数仍未展开',
                      diagnostics: { reason: 'content-expansion-incomplete' },
                    }
                  : { status: 'ok', clicked: 1 },
            },
          ];
        }
        if (source.includes('.capture(')) {
          events.push({ kind: 'capture', at: now });
          return [
            {
              result: {
                status: 'ok',
                url: profile.entry,
                title: chapter.title,
                text: body(),
                markdown: body(),
                html: '<p>' + body() + '</p>',
                links: [],
                warnings: [],
                diagnostics: {},
              },
            },
          ];
        }
        if (source.includes('.readState(')) return [{ result: state() }];
        throw new Error('Unexpected page-side operation');
      },
    },
  };
  return {
    events,
    run: () => createBrowserIO(1).capture(chapter, profile),
  };
}

async function outcome(run) {
  try {
    return { page: await run() };
  } catch (error) {
    return { error };
  }
}

test('body preparation waits for the target chapter body, not just its selected tree row', async (t) => {
  const p = pageBoundary(t, { bodyAt: 4000 });
  const page = await p.run();
  const prepared = p.events.filter((event) => event.kind === 'prepare');
  assert.equal(prepared.length, 1, 'the verified target body must be prepared exactly once');
  assert.ok(prepared[0].at >= 4600, 'the replacement body must settle before preparation');
  assert.equal(prepared[0].before.proof.verified, true);
  assert.equal(prepared[0].before.body.signature, 'Chapter B summary');
  assert.match(page.text, /request: GET \/example/);
  assert.doesNotMatch(page.text, /Chapter A/);
});

test('a preparation signature change settles before the only extraction returns complete examples', async (t) => {
  const p = pageBoundary(t, { expansionMs: 900 });
  const page = await p.run();
  const prepared = p.events.filter((event) => event.kind === 'prepare');
  const captures = p.events.filter((event) => event.kind === 'capture');
  assert.equal(prepared.length, 1);
  assert.equal(captures.length, 1, 'do not extract and discard the first expanded body');
  assert.ok(captures[0].at >= prepared[0].at + 1500, 'wait for loading and renewed stability');
  assert.equal(page.status, 'ok');
  assert.equal(page.navigationProof.verified, true);
  assert.equal(page.text, 'Chapter B summary\nrequest: GET /example\nresponse: {"code":0}');
});

test('incomplete body preparation returns its failure without extracting a partial page', async (t) => {
  const p = pageBoundary(t, { preparation: 'error' });
  const result = await outcome(p.run);
  assert.equal(p.events.filter((event) => event.kind === 'prepare').length, 1);
  assert.equal(p.events.filter((event) => event.kind === 'capture').length, 0);
  assert.ok(result.error || result.page?.status === 'error');
  assert.match(result.error?.message || result.page?.error || '', /正文参数仍未展开/);
});

for (const preparation of ['document-change', 'proof-change'])
  test('body preparation cannot hand off content after ' + preparation, async (t) => {
    const p = pageBoundary(t, { preparation });
    const result = await outcome(p.run);
    assert.equal(p.events.filter((event) => event.kind === 'prepare').length, 1);
    assert.equal(p.events.filter((event) => event.kind === 'capture').length, 0);
    assert.ok(result.error || result.page?.status === 'error', 'the invalid handoff must fail');
  });
