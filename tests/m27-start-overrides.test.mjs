import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ConfigService} from '../dist/config/config-service.js';
import {connect,request} from '../dist/cli/client.js';

test('detached start preserves explicit data directory; a running instance rejects conflicting client overrides',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skf-m27-start-'));
  const cfg=path.join(root,'config'),stored=path.join(root,'stored-data'),chosen=path.join(root,'chosen-data');
  const env={};
  for(const k of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
  Object.assign(env,{NODE_ENV:'test',SKF_CONFIG_DIR:cfg,SKF_SKIP_ENV:'1',SKF_LEARNING:'0',SKF_MEMORY_SEMANTIC:'0',SKF_OPENCLAW_BRIDGE:'0',SKF_BUDGET_MODE:'local-only'});
  const base=new ConfigService({configDir:cfg,env});let info;
  const run=args=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['dist/cli.js',...args,'--config-dir',cfg],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('exit',code=>resolve({code,out,err}));
  });
  try{
    await base.commit(0,{type:'setup',provider:{id:'offline',name:'Offline',adapter:'ollama',baseUrl:'http://127.0.0.1:1/v1'},model:{id:'offline-model',providerId:'offline',modelId:'no-inference',tools:false,vision:false,contextWindowTokens:null},dataDir:stored});
    const start=await run(['start','--headless','--data-dir',chosen]);assert.equal(start.code,0,start.err);
    info=await connect(base);assert.ok(info);
    const actual=await request(info,'GET','/v1/setup/status');assert.equal(path.resolve(actual.dataDir),path.resolve(chosen));
    const other=new ConfigService({configDir:cfg,env,dataDir:stored});
    await assert.rejects(connect(other),e=>e.code==='INSTANCE_CONFIG_CONFLICT');
    const same=new ConfigService({configDir:cfg,env,dataDir:chosen});assert.equal((await connect(same)).instanceId,info.instanceId);
    const status=await run(['status']);assert.equal(status.code,0,status.err);assert.equal(path.resolve(JSON.parse(status.out).dataDir),path.resolve(chosen));
  }finally{
    if(!info)try{info=await connect(base);}catch{}
    if(info)try{await request(info,'POST','/v1/stop',{});}catch{}
    await new Promise(r=>setTimeout(r,600));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  }
});
