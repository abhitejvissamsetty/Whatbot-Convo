import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
let failed = false;
for (const directory of ['tests/unit', 'tests/integration', 'tests/e2e']) {
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.test.js')).sort()) {
    const result = spawnSync(process.execPath, [`${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
