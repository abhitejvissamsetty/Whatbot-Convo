import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else if (name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', name], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
    }
  }
}
for (const directory of ['src', 'scripts', 'public', 'tests']) await walk(directory);
process.stdout.write('JavaScript syntax checks passed\n');
