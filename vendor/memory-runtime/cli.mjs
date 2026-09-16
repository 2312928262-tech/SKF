#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryVault } from './store.mjs';
import { retrieve,indexPending,retryIndex } from './retrieve.mjs';
import { prepare } from './context.mjs';
import { proposeAging } from './maintain.mjs';
const argv=process.argv.slice(2),command=argv.shift();
const options={};for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith('--')||!argv[i+1])throw new Error('EXPECTED_FLAG_VALUE');options[argv[i].slice(2)]=argv[i+1];}
const root=options.root||resolve(import.meta.dirname,'../vault');
const input=options.in?JSON.parse(readFileSync(options.in,'utf8').replace(/^\uFEFF/,'')):{};
const vault=new MemoryVault(root);
try{
  let result;
  switch(command){
    case 'record':result=vault.record(input,input.operationId);break;
    case 'task':result=vault.task(input,input.operationId);break;
    case 'close':result=vault.closeSession(input,input.operationId);break;
    case 'prepare':result=await prepare(vault,input);break;
    case 'search':result=await retrieve(vault,input.query,input);break;
    case 'get':result=vault.get(input.id);break;
    case 'archive':result=vault.archive(input.ids,input);break;
    case 'restore':result=vault.restore(input.id,input.operationId);break;
    case 'index':result=await indexPending(vault,{limit:Number(options.limit||32)});break;
    case 'retry-index':result=retryIndex(vault,input);break;
    case 'verify':result=vault.verify();break;
    case 'status':result=vault.stats();break;
    case 'maintain':result=proposeAging(vault,input);break;
    case 'export':if(!options.out)throw new Error('OUTPUT_REQUIRED');result=vault.export(options.out);break;
    case 'backup':if(!options.out)throw new Error('OUTPUT_REQUIRED');result=vault.backup(options.out);break;
    case 'import':if(!input.file)throw new Error('IMPORT_FILE_REQUIRED');result=vault.importBundle(input.file);break;
    default:throw new Error('UNKNOWN_COMMAND');
  }
  if(options.out&&!['export','backup'].includes(command)){mkdirSync(resolve(options.out,'..'),{recursive:true});writeFileSync(options.out,JSON.stringify(result,null,2),'utf8');process.stdout.write(JSON.stringify({ok:true,output:options.out}));}
  else process.stdout.write(JSON.stringify(result));
}catch(error){process.stderr.write(JSON.stringify({ok:false,code:error.message})+'\n');process.exitCode=1;}finally{vault.close();}
