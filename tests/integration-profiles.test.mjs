import test from 'node:test';
import assert from 'node:assert/strict';
import * as profiles from '../extension/profiles.js';
const base = {
  schemaVersion: 1,
  id: 'saved',
  revision: 1,
  name: 'IPS',
  adapterId: 'generic',
  entry: 'https://old.test/docs/index.html',
  origin: 'https://old.test',
  pathPrefix: '/docs',
  hashMode: 'route',
  queryKeys: ['page'],
  tocSelector: 'nav',
  contentSelector: 'main',
  navigation: 'links',
  samples: [
    { url: 'https://old.test/docs/a.html', title: 'A' },
    { url: 'https://old.test/docs/b.html', title: 'B' },
  ],
};
test('editing capture rules creates an isolated profile identity and clears prior samples', () => {
  assert.equal(typeof profiles.reviseProfile, 'function');
  const original = profiles.validateProfile(base),
    edited = profiles.reviseProfile(original, { contentSelector: '#article' });
  assert.notEqual(edited.id, original.id);
  assert.deepEqual(edited.samples, []);
  assert.equal(original.contentSelector, 'main');
  assert.notEqual(profiles.jobKey(edited, 'IPS', '1'), profiles.jobKey(original, 'IPS', '1'));
  assert.equal(profiles.reviseProfile(edited, { contentSelector: '#article' }).id, edited.id);
});
test('imported rules bind to the current device and path without carrying samples or task identity', () => {
  assert.equal(typeof profiles.bindProfile, 'function');
  const bound = profiles.bindProfile(base, 'https://new.test/manual/index.html?page=home');
  assert.equal(bound.origin, 'https://new.test');
  assert.equal(bound.entry, 'https://new.test/manual/index.html?page=home');
  assert.equal(bound.pathPrefix, '/manual/');
  assert.equal(bound.contentSelector, 'main');
  assert.deepEqual(bound.samples, []);
  assert.notEqual(bound.id, 'saved');
  assert.throws(() => profiles.bindProfile(base, 'https://new.test/manual/?token=SECRET'));
});
test('specification URL validation permits explicit same-origin extensionless documents and rejects action endpoints', () => {
  assert.equal(typeof profiles.specificationURL, 'function');
  for (const path of ['/v3/api-docs', '/openapi', '/docs/openapi.json'])
    assert.equal(
      profiles.specificationURL(path, 'https://device.test/admin/'),
      'https://device.test' + path,
    );
  for (const path of [
    '',
    '   ',
    'https://other.test/openapi',
    '/admin/save.json',
    '/openapi?token=SECRET',
    '/openapi?action=delete',
    'https://u:p@device.test/openapi',
  ])
    assert.throws(() => profiles.specificationURL(path, 'https://device.test/admin/'));
});
test('specification identity separates source and colon-containing metadata fields', () => {
  assert.equal(typeof profiles.specificationTaskId, 'function');
  const key = profiles.specificationTaskId('hash', 'https://one.test/openapi', 'IPS:a', 'b');
  assert.notEqual(
    key,
    profiles.specificationTaskId('hash', 'https://one.test/openapi', 'IPS', 'a:b'),
  );
  assert.notEqual(
    key,
    profiles.specificationTaskId('hash', 'https://two.test/openapi', 'IPS:a', 'b'),
  );
});

const saved = (id = 'saved', entry = 'https://old.test/docs/index.html') =>
  profiles.validateProfile({ ...base, id, entry, samples: [] });
const history = (
  p,
  {
    url = 'https://old.test/docs/known.html',
    updatedAt = '2026-09-16T00:00:00Z',
    product = 'Custom IPS',
    version = 'v2',
  } = {},
) => ({
  sourceKind: 'web',
  taskId: profiles.jobKey(p, product, version),
  profileId: p.id,
  profileRevision: p.revision,
  profile: p,
  entry: p.entry,
  product,
  version,
  updatedAt,
  queue: [{ url, title: 'Known' }],
});
test('saved-profile selection requires entry, sample, or matching historical queue evidence', () => {
  assert.equal(typeof profiles.selectSavedProfile, 'function');
  const p = saved();
  assert.equal(
    profiles.selectSavedProfile('https://old.test/docs/unrelated.html', [p], []).status,
    'none',
  );
  assert.equal(profiles.selectSavedProfile(p.entry, [p], []).profile.id, 'saved');
  assert.equal(
    profiles.selectSavedProfile(
      'https://old.test/docs/sample.html',
      [{ ...p, samples: [{ url: 'https://old.test/docs/sample.html', title: 'S' }] }],
      [],
    ).profile.id,
    'saved',
  );
  assert.equal(
    profiles.selectSavedProfile('https://old.test/docs/known.html', [p], [history(p)]).profile.id,
    'saved',
  );
});
test('unrelated tasks and invalid URLs cannot establish saved-profile membership', () => {
  assert.equal(typeof profiles.selectSavedProfile, 'function');
  const p = saved(),
    t = history(p),
    url = 'https://old.test/docs/known.html';
  for (const changed of [
    { profileId: 'else' },
    { profileRevision: 2 },
    { sourceKind: 'openapi' },
    { profile: { ...p, entry: 'https://old.test/docs/else.html' } },
    { entry: 'https://old.test/docs/else.html' },
  ])
    assert.equal(profiles.selectSavedProfile(url, [p], [{ ...t, ...changed }]).status, 'none');
  assert.equal(
    profiles.selectSavedProfile('https://different.test/outside', [p], []).status,
    'none',
  );
});
test('several proven profiles select only the uniquely most recent corresponding task', () => {
  assert.equal(typeof profiles.selectSavedProfile, 'function');
  const a = saved('a'),
    b = saved('b');
  const old = history(a, { updatedAt: '2026-09-15T00:00:00Z' }),
    recent = history(b, { updatedAt: '2026-09-16T00:00:00Z', product: 'Custom B', version: '42' });
  const result = profiles.selectSavedProfile(a.entry, [a, b], [old, recent]);
  assert.equal(result.profile.id, 'b');
  assert.equal(result.task.product, 'Custom B');
  assert.equal(result.task.version, '42');
});
test('equal instants and missing recency leave saved selection ambiguous', () => {
  assert.equal(typeof profiles.selectSavedProfile, 'function');
  const a = saved('a'),
    b = saved('b');
  for (const records of [
    [],
    [history(a), history(b, { updatedAt: '2026-09-16T08:00:00+08:00' })],
    [history(a, { updatedAt: 'invalid' }), history(b, { updatedAt: '' })],
  ])
    assert.equal(profiles.selectSavedProfile(a.entry, [a, b], records).status, 'ambiguous');
  const tied = [
    history(a),
    history(a, { version: 'different', updatedAt: '2026-09-16T08:00:00+08:00' }),
  ];
  assert.equal(profiles.selectSavedProfile(a.entry, [a], tied).status, 'ambiguous');
});
