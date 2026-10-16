/** Read-only checks for module ownership, dependencies and handoff version drift. */
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const json = async (name) => JSON.parse(await read(name));
const manifest = await json('extension/manifest.json');
const pkg = await json('package.json');
const lock = await json('package-lock.json');
for (const version of [pkg.version, lock.version, lock.packages[''].version])
  assert.equal(version, manifest.version, 'Release versions disagree');
assert.ok(
  (await read('extension/panel.html')).includes(`>${manifest.version}<`),
  'Panel version disagrees',
);
assert.ok(
  (await read('docs/project-status.md')).includes(`当前版本：\`${manifest.version}\``),
  'Update project status for this release',
);
assert.ok(
  (await read('README.md')).includes(`**${manifest.version}**`),
  'Missing current changelog',
);
const map = await json('docs/modules.json');
assert.equal(map.schemaVersion, 1);
const owners = new Map();
const ids = new Set();
for (const module of map.modules) {
  assert.ok(!ids.has(module.id), `Duplicate module: ${module.id}`);
  ids.add(module.id);
  assert.ok(
    module.boundary?.trim() && module.tests?.length,
    `Missing contract/tests: ${module.id}`,
  );
  for (const file of module.files) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), `Invalid path: ${file}`);
    assert.ok(!owners.has(file), `Multiple owners: ${file}`);
    await access(path.join(root, 'extension', file));
    owners.set(file, module.id);
  }
  for (const test of module.tests) {
    assert.match(test, /^tests\/[^/]+\.mjs$/, `Invalid test: ${test}`);
    await access(path.join(root, test));
  }
}
async function inventory(directory = '') {
  const files = [];
  for (const e of await readdir(path.join(root, 'extension', directory), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    assert.ok(!e.isSymbolicLink(), 'Runtime symlink is not allowed');
    const name = path.posix.join(directory, e.name);
    if (e.isDirectory()) files.push(...(await inventory(name)));
    else files.push(name);
  }
  return files;
}
assert.deepEqual(
  (await inventory()).sort(),
  [...owners.keys()].sort(),
  'Register every runtime file exactly once',
);
for (const module of map.modules) {
  for (const dependency of module.dependsOn)
    assert.ok(ids.has(dependency), `Unknown module: ${dependency}`);
  const actual = new Set();
  for (const file of module.files.filter((f) => f.endsWith('.js'))) {
    const code = await read('extension/' + file);
    // All current ES imports/re-exports are static relative paths. Injected page
    // globals and scripting file lists are documented separately in architecture.md.
    for (const match of code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(owners.has(target), `Unregistered import: ${file} -> ${target}`);
      if (owners.get(target) !== module.id) actual.add(owners.get(target));
    }
  }
  assert.deepEqual(
    [...actual].sort(),
    [...module.dependsOn].sort(),
    `Review dependency changes in ${module.id}`,
  );
}
console.log(
  `Handoff ${manifest.version}: ${map.modules.length} modules, ${owners.size} runtime files; ownership and static dependencies checked.`,
);
