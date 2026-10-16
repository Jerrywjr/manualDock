import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocumentURL,
  validateProfile,
  cleanChapter,
  jobKey,
  bindProfile,
} from '../extension/profiles.js';
import * as profileModule from '../extension/profiles.js';
const profilesForSource = (...args) => {
  assert.equal(
    typeof profileModule.profilesForSource,
    'function',
    'source-specific rule filtering must be available',
  );
  return profileModule.profilesForSource(...args);
};
const p = {
  schemaVersion: 1,
  id: 'p',
  revision: 1,
  name: 'test',
  adapterId: 'generic',
  entry: 'https://manual.test/docs/index.html',
  origin: 'https://manual.test',
  pathPrefix: '/docs',
  hashMode: 'route',
  queryKeys: ['page'],
  tocSelector: 'nav',
  contentSelector: 'main',
  navigation: 'links',
};
test('plain paths and hash routes retain chapter identity without requiring query strings', () => {
  assert.equal(normalizeDocumentURL('/docs/a.html', p), 'https://manual.test/docs/a.html');
  assert.notEqual(
    cleanChapter({ url: p.entry + '#/a', title: 'A' }, p).key,
    cleanChapter({ url: p.entry + '#/b', title: 'B' }, p).key,
  );
  assert.equal(
    normalizeDocumentURL('/docs/a.html#heading', { ...p, hashMode: 'anchor' }),
    'https://manual.test/docs/a.html',
  );
});
test('refuses unrelated paths, origins, unknown queries and credential-bearing URLs', () => {
  for (const u of [
    '/docs-evil/a',
    'https://other.test/docs/a',
    '/docs/a?token=secret',
    '/docs/a?unknown=x',
    'https://u:p@manual.test/docs/a',
    '/docs/delete.php',
  ])
    assert.equal(normalizeDocumentURL(u, p), null);
});
test('configuration roundtrip keeps only declarative settings; job identity separates version and rules', () => {
  const v = validateProfile({ ...p, script: 'alert(1)' });
  assert.equal(v.script, undefined);
  assert.notEqual(jobKey(v, 'IPS', '1'), jobKey(v, 'IPS', '2'));
  assert.notEqual(jobKey(v, 'IPS', '1'), jobKey({ ...v, revision: 2 }, 'IPS', '1'));
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(v))), v);
});

test('route hash queries reject decoded authentication keys before profile or chapter persistence', () => {
  const keys = [
    'access_token',
    'sessionid',
    'csrf',
    'auth_token',
    'authorization',
    'credential',
    'ticket',
    'jwt',
    'api-key',
    'sid',
    '%61ccess%5Ftoken',
    '%73essionid',
    '%63srf',
  ];
  for (const key of keys) {
    const url = p.entry + '#/chapter?lang=en&' + key + '=EXAMPLE';
    assert.equal(normalizeDocumentURL(url, p), null, key);
    assert.equal(cleanChapter({ url, title: 'Example' }, p), null, key);
    assert.throws(() => validateProfile({ ...p, entry: url }), /入口/, key);
    assert.throws(() => bindProfile(p, url), /入口/, key);
    assert.equal(
      normalizeDocumentURL('#/next?' + key + '=EXAMPLE', p, p.entry + '#/start'),
      null,
      key,
    );
  }
});
test('ordinary and hash queries use the same authentication-key rule without changing safe route identity', () => {
  for (const key of ['access_token', 'sessionid', 'csrf', '%61ccess%5Ftoken']) {
    assert.equal(
      normalizeDocumentURL('/docs/page?' + key + '=EXAMPLE', { ...p, queryKeys: [key] }),
      null,
      key,
    );
  }
  const url = p.entry + '#/chapter?lang=en&page=02&search=access_token';
  assert.equal(normalizeDocumentURL(url, p), url);
  assert.equal(validateProfile({ ...p, entry: url }).entry, url);
  assert.equal(
    normalizeDocumentURL('/docs/page?page=02', p),
    'https://manual.test/docs/page?page=02',
  );
  assert.equal(
    normalizeDocumentURL(p.entry + '#/chapter&token=EXAMPLE', p),
    null,
    'retain existing ampersand credential guard',
  );
});

test('saved rules stay within the current document instead of leaking same-host management and CLI pages', () => {
  const rule = (id, pathname, pathPrefix = '/') =>
    validateProfile({
      ...p,
      id,
      entry: 'https://manual.test' + pathname,
      pathPrefix,
      queryKeys: ['index', 'dataID'],
      adapterId: 'sangfor',
    });
  const api = rule('api', '/adocs.php?index=22&dataID=api-menu-item80');
  const cli = rule('cli', '/cdocs.php?index=0&dataID=api-menu-item28');
  const management = rule('management', '/framework.php#/mod_home/index');
  const other = rule('other', '/other/index.html', '/other');
  assert.deepEqual(
    profilesForSource('https://manual.test/adocs.php', [api, cli, management, other]).map(
      (v) => v.id,
    ),
    ['api'],
  );
  assert.deepEqual(
    profilesForSource('https://manual.test/cdocs.php?index=49&dataID=api-menu-item100', [
      api,
      cli,
      management,
    ]).map((v) => v.id),
    ['cli'],
  );
  assert.deepEqual(profilesForSource('https://other.test/adocs.php', [api, cli]), []);
});
test('saved generic rules remain reusable across chapter paths inside an explicit manual scope', () => {
  assert.deepEqual(
    profilesForSource('https://manual.test/docs/second.html', [validateProfile(p)]).map(
      (v) => v.id,
    ),
    ['p'],
  );
  assert.deepEqual(
    profilesForSource('https://manual.test/docs-elsewhere/index.html', [validateProfile(p)]),
    [],
  );
  assert.deepEqual(profilesForSource('not a URL', [validateProfile(p)]), []);
});
