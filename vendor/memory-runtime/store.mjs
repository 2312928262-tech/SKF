import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stable, redact, terms } from './text.mjs';

const KINDS=new Set(['identity','preference','fact','decision','lesson','reference','episode']);
const TRUST=new Set(['user_confirmed','tool_observed','legacy','candidate']);
export class MemoryVault {
  constructor(root) {
    this.root=resolve(root);mkdirSync(this.root,{recursive:true});
    this.db=new DatabaseSync(join(this.root,'memory.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,slot TEXT,
        text TEXT NOT NULL,trust TEXT NOT NULL,status TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL,source TEXT NOT NULL,tags TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
        lastAccess TEXT,accessCount INTEGER NOT NULL DEFAULT 0,supersedes TEXT,archivedAt TEXT,contentHash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_scope ON records(scope,status);
      CREATE UNIQUE INDEX IF NOT EXISTS confirmed_slot ON records(scope,slot) WHERE slot IS NOT NULL AND status='active' AND trust IN ('user_confirmed','tool_observed');
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,terms,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,at TEXT NOT NULL,
        op TEXT NOT NULL,subject TEXT NOT NULL,payload TEXT NOT NULL,previousHash TEXT NOT NULL,eventHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,inputHash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,scope TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,
        nextAction TEXT NOT NULL,evidence TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,summary TEXT NOT NULL,decisions TEXT NOT NULL,
        pending TEXT NOT NULL,constraints TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors(recordId TEXT NOT NULL,model TEXT NOT NULL,contentHash TEXT NOT NULL,vector TEXT NOT NULL,
        PRIMARY KEY(recordId,model),FOREIGN KEY(recordId) REFERENCES records(id));
      CREATE TABLE IF NOT EXISTS embedding_jobs(recordId TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT);
      INSERT OR IGNORE INTO meta(key,value) VALUES('schemaVersion','2');`);
    if(this.db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get().value!=='2')throw new Error('UNSUPPORTED_SCHEMA');
  }
  close(){this.db.close();}
  atomic(key,input,fn){
    if(!key || key.length>240)throw new Error('INVALID_OPERATION_KEY');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.db.prepare('SELECT * FROM operations WHERE key=?').get(key), digest=hash(input);
      if(old){if(old.inputHash!==digest)throw new Error('IDEMPOTENCY_CONFLICT');this.db.exec('COMMIT');return JSON.parse(old.result);}
      const result=fn();this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(key,digest,JSON.stringify(result));
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  event(op,subject,payload){
    const last=this.db.prepare('SELECT eventHash FROM events ORDER BY seq DESC LIMIT 1').get();
    const e={id:randomUUID(),at:new Date().toISOString(),op,subject,payload,previousHash:last?.eventHash||'GENESIS'};
    const digest=hash(e);
    this.db.prepare('INSERT INTO events(id,at,op,subject,payload,previousHash,eventHash) VALUES(?,?,?,?,?,?,?)')
      .run(e.id,e.at,op,subject,JSON.stringify(payload),e.previousHash,digest);
  }
  get(id){const r=this.db.prepare('SELECT * FROM records WHERE id=?').get(id);return r?{...r,source:JSON.parse(r.source),tags:JSON.parse(r.tags)}:null;}
  record(input,key){return this.atomic(key,input,()=>this._record(input));}
  _record(input){
    const text=redact(input.text||'').trim(),kind=input.kind||'fact',scope=input.scope||'global',trust=input.trust||'candidate';
    if(!text || text.length>12000 || !KINDS.has(kind) || !TRUST.has(trust) || !/^[\p{L}\p{N}_.:/-]{1,100}$/u.test(scope))throw new Error('INVALID_RECORD');
    if(!Array.isArray(input.source)||!input.source.length||input.source.some(s=>typeof s.locator!=='string'||!s.locator))throw new Error('SOURCE_REQUIRED');
    if(trust==='user_confirmed'&&!input.source.some(s=>s.kind==='user'))throw new Error('USER_EVIDENCE_REQUIRED');
    if(trust==='tool_observed'&&!input.source.some(s=>s.kind==='tool'))throw new Error('TOOL_EVIDENCE_REQUIRED');
    if(input.pinned && !['user_confirmed','tool_observed'].includes(trust))throw new Error('PIN_REQUIRES_EVIDENCE');
    const contentHash=hash(text),slot=input.slot||null;
    const existing=this.db.prepare("SELECT id FROM records WHERE scope=? AND contentHash=? AND kind=? AND status IN ('active','candidate') AND trust=? AND COALESCE(slot,'')=COALESCE(?,'')").get(scope,contentHash,kind,trust,slot);
    if(existing){
      const record=this.get(existing.id),sources=[...record.source];
      for(const s of input.source)if(!sources.some(old=>old.locator===s.locator&&old.hash===(s.hash||null)))sources.push({kind:s.kind||'reference',locator:redact(s.locator),hash:s.hash||null});
      if(sources.length!==record.source.length){this.db.prepare('UPDATE records SET source=? WHERE id=?').run(JSON.stringify(sources),existing.id);this.event('merge_sources',existing.id,{source:sources});}
      return {id:existing.id,status:record.status,deduplicated:true};
    }
    let status=trust==='candidate'?'candidate':'active';
    const occupied=slot?this.db.prepare("SELECT * FROM records WHERE scope=? AND slot=? AND status='active' AND trust IN ('user_confirmed','tool_observed')").get(scope,slot):null;
    if(occupied){
      if(input.supersedes===occupied.id && trust==='user_confirmed' && input.reason){
        this.db.prepare("UPDATE records SET status='superseded',updatedAt=? WHERE id=?").run(new Date().toISOString(),occupied.id);
        this.event('supersede',occupied.id,{reason:redact(input.reason)});
      }else status='candidate';
    }else if(input.supersedes)throw new Error('SUPERSEDES_TARGET_NOT_ACTIVE');
    const id=input.id||randomUUID(),at=new Date().toISOString(),confidence=Number(input.confidence??(trust==='user_confirmed'?1:trust==='tool_observed'?0.9:0.5));
    if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('INVALID_CONFIDENCE');
    const source=input.source.map(s=>({kind:s.kind||'reference',locator:redact(s.locator),hash:s.hash||null}));
    const tags=(input.tags||[]).map(String).slice(0,20);
    this.db.prepare('INSERT INTO records(id,kind,scope,slot,text,trust,status,pinned,confidence,source,tags,createdAt,updatedAt,supersedes,contentHash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,kind,scope,slot,text,trust,status,input.pinned&&status==='active'?1:0,confidence,JSON.stringify(source),JSON.stringify(tags),at,at,input.supersedes||null,contentHash);
    this.db.prepare('INSERT INTO search(id,terms) VALUES(?,?)').run(id,terms(text+' '+tags.join(' ')).join(' '));
    this.db.prepare('INSERT INTO embedding_jobs(recordId) VALUES(?)').run(id);
    this.event('record',id,{kind,scope,slot,text,trust,status,pinned:!!input.pinned,confidence,source,tags,contentHash,supersedes:input.supersedes||null});
    return {id,status,conflictWith:status==='candidate'?occupied?.id||null:null};
  }
  task(input,key){return this.atomic(key,input,()=>this._task(input));}
  _task(input){
    if(!input.id||!input.title||!['pending','running','blocked','done','cancelled'].includes(input.state))throw new Error('INVALID_TASK');
    if(input.state==='done'&&(!input.evidence?.length))throw new Error('DONE_REQUIRES_EVIDENCE');
    const task={id:input.id,scope:input.scope||'global',title:redact(input.title),state:input.state,nextAction:redact(input.nextAction||''),evidence:input.evidence||[],updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,title=excluded.title,state=excluded.state,nextAction=excluded.nextAction,evidence=excluded.evidence,updatedAt=excluded.updatedAt')
      .run(task.id,task.scope,task.title,task.state,task.nextAction,JSON.stringify(task.evidence),task.updatedAt);
    this.event('task',task.id,task);return task;
  }
  closeSession(input,key){
    return this.atomic(key,input,()=>{
      if(!input.sessionId||!input.summary?.trim())throw new Error('SESSION_SUMMARY_REQUIRED');
      const session={id:input.sessionId,scope:input.scope||'global',summary:redact(input.summary),
        decisions:(input.decisions||[]).map(redact),pending:(input.pending||[]).map(redact),constraints:(input.constraints||[]).map(redact),updatedAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,summary=excluded.summary,decisions=excluded.decisions,pending=excluded.pending,constraints=excluded.constraints,updatedAt=excluded.updatedAt')
        .run(session.id,session.scope,session.summary,JSON.stringify(session.decisions),JSON.stringify(session.pending),JSON.stringify(session.constraints),session.updatedAt);
      const memories=(input.memories||[]).map(m=>this._record(m));
      const tasks=(input.tasks||[]).map(t=>this._task(t));
      const episode=this._record({kind:'episode',scope:session.scope,trust:'legacy',text:session.summary,
        source:[{kind:'session_note',locator:'session:'+session.id}],tags:['session-summary']});
      this.event('session',session.id,session);
      return {sessionId:session.id,episode,memories,tasks,indexPending:true};
    });
  }
  archive(ids,{dryRun=true,reason='manual archive',operationId}={}){
    const validate=()=>{const selected=ids.map(id=>this.get(id));
      if(selected.some(r=>!r||r.pinned||!['fact','reference','episode'].includes(r.kind)||r.status!=='active'))throw new Error('ARCHIVE_PROTECTED_OR_INVALID');return selected;};
    if(dryRun){validate();return {dryRun:true,ids};}
    if(!operationId)throw new Error('ARCHIVE_OPERATION_ID_REQUIRED');
    return this.atomic(operationId,{ids,reason},()=>{
      const selected=validate();
      for(const r of selected){const current=this.get(r.id);if(current.pinned||current.status!=='active')throw new Error('ARCHIVE_CHANGED');this.db.prepare("UPDATE records SET status='archived',archivedAt=? WHERE id=?").run(new Date().toISOString(),r.id);this.event('archive',r.id,{reason});}
      return {archived:ids};
    });
  }
  restore(id,key){return this.atomic(key,{id},()=>{
    const r=this.get(id);if(!r||r.status!=='archived')throw new Error('NOT_ARCHIVED');
    if(r.slot&&this.db.prepare("SELECT id FROM records WHERE scope=? AND slot=? AND status='active' AND id<>?").get(r.scope,r.slot,id))throw new Error('RESTORE_CONFLICT');
    this.db.prepare("UPDATE records SET status='active',archivedAt=NULL WHERE id=?").run(id);this.event('restore',id,{});return {restored:id};
  });}
  access(ids,key){return this.atomic(key,{ids},()=>{for(const id of new Set(ids))this.db.prepare('UPDATE records SET accessCount=accessCount+1,lastAccess=? WHERE id=?').run(new Date().toISOString(),id);this.event('access','records',{ids});return {count:ids.length};});}
  verify(){
    let previousHash='GENESIS',count=0;
    for(const row of this.db.prepare('SELECT * FROM events ORDER BY seq').all()){
      const e={id:row.id,at:row.at,op:row.op,subject:row.subject,payload:JSON.parse(row.payload),previousHash:row.previousHash};
      if(row.previousHash!==previousHash||hash(e)!==row.eventHash)throw new Error('AUDIT_CHAIN_INVALID');previousHash=row.eventHash;count++;
    }
    if(this.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('DATABASE_INTEGRITY_FAILED');
    return {ok:true,eventCount:count,head:previousHash};
  }
  export(file){
    this.db.exec('BEGIN');let data;
    try{data={schemaVersion:2,createdAt:new Date().toISOString(),records:this.db.prepare('SELECT * FROM records').all(),
      tasks:this.db.prepare('SELECT * FROM tasks').all(),sessions:this.db.prepare('SELECT * FROM sessions').all(),events:this.db.prepare('SELECT * FROM events ORDER BY seq').all(),operations:this.db.prepare('SELECT * FROM operations').all()};
      data.assets=[];
      for(const directory of ['sources','context-inputs','writeback-queue'])if(existsSync(join(this.root,directory)))for(const name of readdirSync(join(this.root,directory))){
        if(!/^[a-f0-9]{64}(\.(pending|done))?\.(md|json)$/.test(name))continue;
        const content=readFileSync(join(this.root,directory,name),'utf8');data.assets.push({path:directory+'/'+name,content,sha256:hash(content)});
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const envelope={...data,checksum:hash(data)};mkdirSync(resolve(file,'..'),{recursive:true});
    writeFileSync(file+'.tmp',JSON.stringify(envelope,null,2),{encoding:'utf8',flush:true});renameSync(file+'.tmp',file);
    return {file,records:data.records.length,checksum:envelope.checksum};
  }
  backup(file){mkdirSync(resolve(file,'..'),{recursive:true});this.db.prepare('VACUUM INTO ?').run(resolve(file));return {file};}
  importBundle(file){
    const {checksum,...data}=JSON.parse(readFileSync(file,'utf8'));
    if(data.schemaVersion!==2||hash(data)!==checksum)throw new Error('IMPORT_CHECKSUM_FAILED');
    for(const asset of data.assets||[])if(!/^(sources|context-inputs|writeback-queue)\/[a-f0-9]{64}(\.(pending|done))?\.(md|json)$/.test(asset.path)||hash(asset.content)!==asset.sha256)throw new Error('IMPORT_ASSET_INVALID');
    if(this.db.prepare('SELECT count(*) n FROM records').get().n||this.db.prepare('SELECT count(*) n FROM events').get().n)throw new Error('RESTORE_REQUIRES_EMPTY_VAULT');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of ['records','tasks','sessions','events','operations']){
        const columns=this.db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
        const insert=this.db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
        for(const row of data[table]||[])insert.run(...columns.map(c=>row[c]??null));
      }
      this.verify();
      for(const record of this.db.prepare('SELECT * FROM records').all()){
        this.db.prepare('INSERT INTO search VALUES(?,?)').run(record.id,terms(record.text+' '+JSON.parse(record.tags).join(' ')).join(' '));
        this.db.prepare('INSERT INTO embedding_jobs(recordId) VALUES(?)').run(record.id);
      }
      for(const asset of data.assets||[]){const file=join(this.root,asset.path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file+'.tmp',asset.content,{encoding:'utf8',flush:true});renameSync(file+'.tmp',file);}
      this.db.exec('COMMIT');return {restoredRecords:data.records.length,semanticIndex:'rebuild-required'};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  stats(){return {schema:2,records:this.db.prepare('SELECT status,kind,count(*) count FROM records GROUP BY status,kind').all(),tasks:this.db.prepare('SELECT state,count(*) count FROM tasks GROUP BY state').all(),embeddingJobs:this.db.prepare('SELECT state,count(*) count FROM embedding_jobs GROUP BY state').all()};}
}
