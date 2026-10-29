import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from '../src/config/env.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function projectServers(projectRoot, procRoot = '/proc') {
  const expected = await realpath(projectRoot);
  const serverPath = resolve(expected, 'src/server.js');
  const result = [];
  for (const entry of await readdir(procRoot, { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name) || Number(entry.name) === process.pid) continue;
    const processPath = `${procRoot}/${entry.name}`;
    try {
      const owner = await stat(processPath);
      if (owner.uid !== process.getuid()) continue;
      if (await realpath(`${processPath}/cwd`) !== expected) continue;
      const args = (await readFile(`${processPath}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (!/^node(?:js)?$/.test(args[0]?.split('/').at(-1))) continue;
      const entrypoint = args.slice(1).find(arg => !arg.startsWith('-'));
      if (entrypoint && resolve(expected, entrypoint) === serverPath) result.push(Number(entry.name));
    } catch { /* Process may have exited or belong to another namespace. */ }
  }
  return result;
}

async function main() {
  const c = config();
  if (c.mode !== 'mock' || c.production) throw new Error('This command only restarts the local mock app. Use your deployment manager for live services.');
  const processes = await projectServers(root);
  for (const pid of processes) {
    process.stdout.write(`Stopping verified local project server (PID ${pid})\n`);
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && (await projectServers(root)).length) await new Promise(resolve => setTimeout(resolve, 100));
  if ((await projectServers(root)).length) throw new Error('The existing server is still stopping. Wait for it to exit, then run this command again. No process was force-killed.');
  process.stdout.write(`Starting current application from ${root}\n`);
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], { cwd: root, stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
  child.on('error', error => { process.stderr.write(`Unable to start app: ${error.code}\n`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
