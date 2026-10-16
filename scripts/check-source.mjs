/** Parse all executable JavaScript without running product or browser actions. */
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const directory of ['extension', 'scripts', 'tests']) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name)) continue;
    const result = spawnSync(
      process.execPath,
      ['--check', path.join(root, directory, entry.name)],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
console.log(`Parsed ${count} JavaScript files.`);
