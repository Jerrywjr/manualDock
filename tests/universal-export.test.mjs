import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExports } from '../extension/core.js';
test('v2 archive retains profile identity and generic directory provenance without exposing browser state', () => {
  const job = {
    schemaVersion: 2,
    taskId: 'task',
    profileId: 'p',
    profileRevision: 2,
    profile: { id: 'p', revision: 2 },
    sourceKind: 'web',
    entry: 'https://manual.test/docs/',
    product: 'Generic',
    version: '1',
    queue: [
      {
        key: 'k',
        url: 'https://manual.test/docs/',
        title: 'Leaf',
        status: 'captured',
        locator: { kind: 'generic-toc', path: ['Parent', 'Leaf'] },
      },
    ],
    pages: {
      k: {
        status: 'ok',
        url: 'https://manual.test/docs/',
        text: 'Content',
        markdown: 'Content',
        html: '<p>Content</p>',
      },
    },
    cookies: 'never export',
  };
  const exports = buildExports(job),
    data = JSON.parse(exports.json);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.taskId, 'task');
  assert.equal(data.profileRevision, 2);
  assert.match(exports.report, /Parent > Leaf/);
  assert.equal(data.cookies, undefined);
});
