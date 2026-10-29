import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repoName = process.argv[2] || 'whatsapp-commerce-assistant';
if (process.argv.includes('--help')) {
  console.log('Usage: npm run repo:create -- [repository-name]');
  console.log('Creates a new private GitHub repository using the authenticated account as owner and author.');
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}. Install Git and GitHub CLI, and run this from your desktop terminal.`);
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr?.trim() || 'see terminal output'}`);
  return result.stdout?.trim() || '';
}

try {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repoName)) throw new Error('Use a repository name containing letters, numbers, dots, underscores or hyphens.');
  run('git', ['--version']);
  const owner = JSON.parse(run('gh', ['api', '--hostname', 'github.com', 'user']));
  if (!/^[a-zA-Z0-9-]+$/.test(owner.login) || !Number.isSafeInteger(owner.id)) throw new Error('GitHub did not return a valid owner identity.');
  const existing = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (existing.status === 0 && existing.stdout.trim() !== root.replace(/\/$/, '')) throw new Error('This folder belongs to another repository. Run this only in an independent project folder.');
  if (spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' }).status === 0) throw new Error('This project already has commits. This helper only handles initial publication; it will not rewrite existing history.');
  if (spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: 'ignore' }).status === 0) throw new Error('An origin remote already exists. No changes were made.');

  const email = `${owner.id}+${owner.login}@users.noreply.github.com`;
  const fullName = `${owner.login}/${repoName}`;
  const url = `https://github.com/${fullName}`;
  console.log(`Creating private repository ${fullName}; author and committer: ${owner.login} <${email}>`);
  run('git', ['init', '--initial-branch=main', '.']);
  run('git', ['config', '--local', 'user.name', owner.login]);
  run('git', ['config', '--local', 'user.email', email]);
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.author = { name: owner.login, email, url: `https://github.com/${owner.login}` };
  pkg.repository = { type: 'git', url: `${url}.git` };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const readmePath = new URL('../README.md', import.meta.url);
  const readme = readFileSync(readmePath, 'utf8');
  const ownership = `<!-- repository-owner -->\nRepository owner and maintainer: [${owner.login}](https://github.com/${owner.login}).\n<!-- /repository-owner -->`;
  writeFileSync(readmePath, `${readme.replace(/\n*<!-- repository-owner -->[\s\S]*?<!-- \/repository-owner -->\n*/g, '\n').trimEnd()}\n\n${ownership}\n`);
  run('git', ['add', '.']);
  const files = run('git', ['ls-files', '-z']).split('\0').filter(Boolean);
  const sensitive = files.filter(path => path.split('/').some(part =>
    ['node_modules', '.aws', '.codex', '.agents', 'artifacts'].includes(part) ||
    (part !== '.env.example' && (part === '.env' || part.startsWith('.env.'))) || /\.(pem|key|p12|pfx)$/i.test(part)));
  if (sensitive.length) throw new Error('Sensitive or generated files are staged. Remove them from the index before publishing. Nothing has been pushed.');
  run('git', ['commit', '-m', 'Initial implementation'], {
    stdio: 'inherit',
    env: { ...process.env, GIT_AUTHOR_NAME: owner.login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: owner.login, GIT_COMMITTER_EMAIL: email },
  });
  run('gh', ['repo', 'create', fullName, '--private', '--source=.', '--remote=origin', '--push'], { stdio: 'inherit' });
  console.log(`Repository published: ${url}`);
} catch (error) {
  console.error(error.message);
  console.error('If publication failed after the initial commit, keep that commit. Check gh repo view and git remote -v, then retry the push or create the repository with gh repo create.');
  process.exitCode = 1;
}
