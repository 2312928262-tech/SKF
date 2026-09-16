import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {MemoryVault} from './store.mjs';
import {retrieve,indexPending,retryIndex} from './retrieve.mjs';
import {prepare} from './context.mjs';
import {project} from './project.mjs';
import {proposeAging} from './maintain.mjs';
import {hash,redact,chunks} from './text.mjs';
const clean=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])):value;
function save(file,value){mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{encoding:'utf8',flush:true});renameSync(file+'.tmp',file);}
export function syncLessons(vault,workspace){
  const folder=join(workspace,'memory/mistakes');if(!existsSync(folder))return {files:0};let files=0;
  for(const name of readdirSync(folder).filter(n=>n.endsWith('.md')&&n!=='INDEX.md')){
    const content=redact(readFileSync(join(folder,name),'utf8')),digest=hash(content),relative='sources/'+digest+'.md';
    mkdirSync(join(vault.root,'sources'),{recursive:true});if(!existsSync(join(vault.root,relative)))writeFileSync(join(vault.root,relative),content,{encoding:'utf8',flush:true});
    chunks(content).forEach((part,index)=>vault.record({text:part.text,kind:'lesson',trust:'legacy',scope:'global',source:[{kind:'legacy_file',locator:relative+'#chunk-'+index,hash:digest}],tags:['mistake','historical-guidance']},'lesson-file:'+digest+':'+index));files++;
  }return {files};
}
export function replayWritebacks(vault){
  const folder=join(vault.root,'writeback-queue');mkdirSync(folder,{recursive:true});const report={replayed:0,failed:[]};
  for(const name of readdirSync(folder).filter(n=>/^[a-f0-9]{64}\.pending\.json$/.test(n))){
    const file=join(folder,name);try{const input=JSON.parse(readFileSync(file,'utf8'));vault.closeSession(input,input.operationId);renameSync(file,file.replace('.pending.','.done.'));report.replayed++;}catch(error){report.failed.push({file,code:error.message});}
  }return report;
}
export async function run(command,input={},options={}){
  const vault=new MemoryVault(options.root||resolve(import.meta.dirname,'../vault')),workspace=options.workspace;
  try{
    let result;const maintenance={};
    if(['prepare','close','sync','maintain'].includes(command)){
      if(workspace)maintenance.lessons=syncLessons(vault,workspace);
      maintenance.writebacks=replayWritebacks(vault);
    }
    switch(command){
      case 'prepare':result=await prepare(vault,input);break;
      case 'search':result=await retrieve(vault,input.query,input);break;
      case 'get':result=vault.get(input.id);break;
      case 'record':result=vault.record(input,input.operationId);break;
      case 'task':result=vault.task(input,input.operationId);break;
      case 'close':{
        if(!input.operationId)throw new Error('CLOSE_OPERATION_ID_REQUIRED');
        const safe=clean(input),base=join(vault.root,'writeback-queue',hash(safe.operationId)),pending=base+'.pending.json',done=base+'.done.json';
        const existing=existsSync(done)?done:existsSync(pending)?pending:null;
        if(existing&&hash(JSON.parse(readFileSync(existing,'utf8')))!==hash(safe))throw new Error('IDEMPOTENCY_CONFLICT');
        if(!existing)save(pending,safe);
        result=vault.closeSession(safe,safe.operationId);
        if(existsSync(pending))renameSync(pending,done);
        if(input.semantic!==false)maintenance.index=await indexPending(vault,{limit:8});
        maintenance.aging=proposeAging(vault);break;
      }
      case 'archive':result=vault.archive(input.ids,input);break;
      case 'restore':result=vault.restore(input.id,input.operationId);break;
      case 'index':result=await indexPending(vault,{limit:input.limit??32});break;
      case 'retry-index':result=retryIndex(vault,input);break;
      case 'sync':result={synced:true};break;
      case 'maintain':result=proposeAging(vault,input);break;
      case 'status':result=vault.stats();break;
      case 'verify':result=vault.verify();break;
      // M10（SKF 侧增补，已随 M10 证据重审）：只读快照备份，路径由调用方（SKF 后端）生成，UI 不可指定。
      case 'backup':{if(!input.file||typeof input.file!=='string')throw new Error('BACKUP_FILE_REQUIRED');result=vault.backup(input.file);break;}
      default:throw new Error('UNKNOWN_INTEGRATION_COMMAND');
    }
    if(workspace&&command!=='get'&&command!=='search')maintenance.projection=project(vault,workspace);
    return {ok:true,health:maintenance.writebacks?.failed.length?'attention_required':'ready',result,maintenance};
  }finally{vault.close();}
}
