import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const php = process.env.PHP_BIN || 'php';
const available = spawnSync(php, ['-v']).status === 0;
test('WordPress bridge authentication and input validation contract', { skip: !available }, () => {
  const result = spawnSync(php, ['tests/fixtures/bridge-security.php'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
