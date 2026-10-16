import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const script = new URL(
  '../skill/import-security-manuals/scripts/inspect_archive.py',
  import.meta.url,
).pathname;
const entry = 'https://manual.example.test/adocs.php';
const one = entry + '?index=1&dataID=api-menu-item51';
const two = entry + '?index=2&dataID=api-menu-item52';
const temporaryRoot = fileURLToPath(new URL('../internal/', import.meta.url));
fs.mkdirSync(temporaryRoot, { recursive: true });
function archiveFile(t) {
  const temp = fs.mkdtempSync(path.join(temporaryRoot, 'manual-archive-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'archive.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      entry,
      product: 'IPS',
      version: '未知',
      queue: [
        { url: one, title: '网络对象', status: 'captured' },
        { url: two, title: '配置', status: 'captured' },
      ],
      pages: {
        [one]: {
          status: 'ok',
          text: '网络对象包含地址和掩码。',
          warnings: ['图示未保存'],
          hash: 'test',
        },
      },
      discoveryWarnings: ['未核对目录'],
      cookies: 'must-not-output',
    }),
  );
  return file;
}
test('archive inspection counts only existing valid body and names missing chapters', (t) => {
  const file = archiveFile(t);
  const report = JSON.parse(execFileSync('python3', [script, file], { encoding: 'utf8' }));
  assert.equal(report.saved, 1);
  assert.equal(report.discovered, 2);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].url, two);
  assert.equal(report.complete, false);
  assert.ok(!JSON.stringify(report).includes('must-not-output'));
});
test('archive search returns evidence and unknown version without dumping image blobs', (t) => {
  const file = archiveFile(t);
  const report = JSON.parse(
    execFileSync('python3', [script, file, '--query', '网络对象', '--limit', '1'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].url, one);
  assert.equal(report.matches[0].text, '网络对象包含地址和掩码。');
  assert.equal(report.version, '未知');
  assert.deepEqual(report.matches[0].warnings, ['图示未保存']);
});

test('tree archive inspection searches independent same-URL bodies and returns actual source and path', (t) => {
  const file = archiveFile(t);
  const first = 'toc:first';
  const second = 'toc:second';
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      entry,
      queue: [
        {
          key: first,
          url: entry,
          title: '1.1 Topic',
          locator: { kind: 'sangfor-ext-tree', path: ['1 Part', '1.1 Topic'] },
          status: 'captured',
        },
        {
          key: second,
          url: entry,
          title: '2.1 Topic',
          locator: { kind: 'sangfor-ext-tree', path: ['2 Part', '2.1 Topic'] },
          status: 'captured',
        },
      ],
      pages: {
        [first]: { status: 'ok', url: one, text: 'shared topic first' },
        [second]: { status: 'ok', url: entry, text: 'shared topic second' },
      },
    }),
  );
  const report = JSON.parse(
    execFileSync('python3', [script, file, '--query', 'shared'], { encoding: 'utf8' }),
  );
  assert.equal(report.saved, 2);
  assert.equal(report.matches.length, 2);
  assert.equal(report.matches[0].key, first);
  assert.equal(report.matches[0].url, one);
  assert.deepEqual(report.matches[0].locator.path, ['1 Part', '1.1 Topic']);
  assert.equal(report.matches[1].text, 'shared topic second');
});
