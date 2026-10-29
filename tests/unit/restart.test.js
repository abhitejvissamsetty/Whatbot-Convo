import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectServers } from '../../scripts/restart-local.js';

test('restart discovery selects only this project Node server, excluding workers and other applications',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'convo-restart-'));
  const project=join(directory,'project'),other=join(directory,'other'),proc=join(directory,'proc');
  await Promise.all([mkdir(project),mkdir(other),mkdir(proc)]);
  const base=process.pid+100000;
  try{
    for(const [offset,cwd,args]of [
      [1,project,['/usr/bin/node','--env-file-if-exists=.env','src/server.js']],
      [2,other,['/usr/bin/node','src/server.js']],
      [3,project,['/usr/bin/node','src/worker.js']],
      [4,project,['/usr/bin/python','src/server.js']],
      [5,project,['/usr/bin/node','scripts/restart-local.js']],
      [6,project,['/usr/bin/node','src/worker.js','src/server.js']],
    ]){const path=join(proc,String(base+offset));await mkdir(path);await symlink(cwd,join(path,'cwd'));await writeFile(join(path,'cmdline'),args.join('\0')+'\0');}
    assert.deepEqual(await projectServers(project,proc),[base+1]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
