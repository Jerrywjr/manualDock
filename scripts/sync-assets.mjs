/** The extension directory is authoritative; Skill assets are a generated mirror. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
let count = 0;
async function sync(relative = '') {
  for (const entry of await readdir(path.join(root, 'extension', relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked runtime files are not supported: ' + name);
    if (entry.isDirectory()) {
      await sync(name);
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const source = await readFile(path.join(root, 'extension', name));
    const target = path.join(root, 'skill/import-security-manuals/assets/extension', name);
    if (check) {
      let copy;
      try {
        copy = await readFile(target);
      } catch {
        throw new Error('Missing Skill asset: ' + name);
      }
      if (!source.equals(copy)) throw new Error('Stale Skill asset: ' + name);
    } else await writeFile(target, source);
    count++;
  }
}
await sync();
console.log(`${check ? 'Checked' : 'Synchronized'} ${count} runtime assets.`);
