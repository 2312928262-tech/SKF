import { existsSync, readFileSync, mkdirSync, lstatSync, chmodSync, realpathSync, openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync, readdirSync, statfsSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONFIG_SCHEMA = 1;
export const MANAGEMENT_PROTOCOL = 1;
export class ConfigError extends Error { constructor(public code: string) { super(code); } }
export function fail(code: string): never { throw new ConfigError(code); }
export const presets = {
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', alias: 'KIMI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', alias: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', alias: 'OPENAI_API_KEY' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', alias: '' },
  vllm: { baseUrl: 'http://127.0.0.1:8000/v1', model: '', alias: '' },
  compatible: { baseUrl: '', model: '', alias: '' },
} as const;
export type Adapter = keyof typeof presets;
export interface ProviderRecord { id: string; name: string; adapter: Adapter; baseUrl: string; credentialRef?: string; }
export interface ModelRecord { id: string; providerId: string; modelId: string; tools: boolean; vision: boolean; contextWindowTokens: number | null; lastTest?: { code: string; at: string; latencyMs: number; inference: boolean }; }
export interface Registry { schemaVersion: number; revision: number; providers: ProviderRecord[]; models: ModelRecord[]; defaultModelRef: string | null; }
export type ConfigCommand =
 | { type: 'setup'; provider: unknown; model: unknown; key?: string; dataDir: string; acknowledgeCustomEndpoint?: boolean }
 | { type: 'provider.add'; provider: unknown; key?: string; acknowledgeCustomEndpoint?: boolean }
 | { type: 'provider.edit'; id: string; patch: unknown; acknowledgeCredentialRemoval?: boolean }
 | { type: 'provider.key'; id: string; key: string; acknowledgeCustomEndpoint?: boolean }
 | { type: 'provider.remove'; id: string }
 | { type: 'model.add'; model: unknown }
 | { type: 'model.edit'; id: string; patch: unknown }
 | { type: 'model.remove'; id: string }
 | { type: 'model.default'; id: string }
 | { type: 'model.test-result'; id: string; result: ModelRecord['lastTest'] };
const empty = (): Registry => ({ schemaVersion: CONFIG_SCHEMA, revision: 0, providers: [], models: [], defaultModelRef: null });
const safeText = (x: unknown, max = 256): string => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\x00-\x1f\x7f]/.test(x) ? x : fail('CONFIG_INVALID');
const id = (x: unknown) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeText(x, 64)) ? x as string : fail('CONFIG_INVALID_ID');
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail('CONFIG_INVALID');
const fields = (x: Record<string, unknown>, allowed: string[]) => { if (Object.keys(x).some(k => !allowed.includes(k))) fail('CONFIG_UNKNOWN_FIELD'); };
export function loopback(host: string) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'; }
export function endpoint(value: unknown) {
  const text = safeText(value, 2048); let u: URL; try { u = new URL(text); } catch { return fail('ENDPOINT_INVALID'); }
  if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) fail('ENDPOINT_INVALID');
  if (u.protocol === 'http:' && !loopback(u.hostname)) fail('ENDPOINT_TLS_REQUIRED');
  return u.toString().replace(/\/+$/, '');
}
export function validateProvider(value: unknown): ProviderRecord {
  const p = object(value); fields(p, ['id','name','adapter','baseUrl','credentialRef']);
  if (typeof p.adapter !== 'string' || !Object.hasOwn(presets, p.adapter)) fail('ADAPTER_UNSUPPORTED');
  if (p.credentialRef !== undefined && !/^SKF_CREDENTIAL_[A-Z0-9_]{1,100}$/.test(String(p.credentialRef))) fail('CREDENTIAL_REF_INVALID');
  return { id: id(p.id), name: safeText(p.name || p.id, 100), adapter: p.adapter as Adapter, baseUrl: endpoint(p.baseUrl), ...(p.credentialRef ? { credentialRef: String(p.credentialRef) } : {}) };
}
export function validateModel(value: unknown): ModelRecord {
  const m = object(value); fields(m,['id','providerId','modelId','tools','vision','contextWindowTokens','lastTest']);
  if (m.tools !== undefined && typeof m.tools !== 'boolean' || m.vision !== undefined && typeof m.vision !== 'boolean') fail('CONFIG_INVALID');
  const n = m.contextWindowTokens ?? null; if (n !== null && (!Number.isSafeInteger(n) || (n as number) < 1)) fail('CONFIG_INVALID');
  let lastTest: ModelRecord['lastTest']; if (m.lastTest) { const t=object(m.lastTest);fields(t,['code','at','latencyMs','inference']);if(!/^[A-Z_]{2,64}$/.test(String(t.code))||!Number.isFinite(t.latencyMs)||typeof t.inference!=='boolean'||Number.isNaN(Date.parse(String(t.at))))fail('CONFIG_INVALID');lastTest=t as unknown as ModelRecord['lastTest']; }
  return { id:id(m.id), providerId:id(m.providerId), modelId:safeText(m.modelId,200), tools:m.tools === true, vision:m.vision === true, contextWindowTokens:n as number|null, ...(lastTest?{lastTest}:{}) };
}
function validateRegistry(v: unknown): Registry {
  const r=object(v); fields(r,['schemaVersion','revision','providers','models','defaultModelRef']);
  if (r.schemaVersion !== CONFIG_SCHEMA) fail('CONFIG_SCHEMA_UNSUPPORTED');
  if (!Number.isSafeInteger(r.revision) || (r.revision as number)<0 || !Array.isArray(r.providers)||!Array.isArray(r.models)||r.providers.length>100||r.models.length>1000) fail('CONFIG_INVALID');
  const providers=r.providers.map(validateProvider), models=r.models.map(validateModel);
  if(new Set(providers.map(p=>p.id)).size!==providers.length || new Set(models.map(m=>m.id)).size!==models.length)fail('CONFIG_DUPLICATE');
  if(models.some(m=>!providers.some(p=>p.id===m.providerId)) || (r.defaultModelRef!==null&&!models.some(m=>m.id===r.defaultModelRef)))fail('CONFIG_REFERENCE_INVALID');
  return {schemaVersion:CONFIG_SCHEMA,revision:r.revision as number,providers,models,defaultModelRef:r.defaultModelRef as string|null};
}
export function parseEnv(text: string): Record<string,string> {
  const out: Record<string,string>=Object.create(null);
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!m||Object.hasOwn(out,m[1]))fail('CONFIG_ENV_INVALID');let value=m[2];if(value.startsWith('"')){try{value=JSON.parse(value);}catch{fail('CONFIG_ENV_INVALID');}}else if(value.startsWith("'")){if(!value.endsWith("'"))fail('CONFIG_ENV_INVALID');value=value.slice(1,-1);}if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))fail('CONFIG_ENV_INVALID');out[m[1]]=value;}
  return out;
}
const serializeEnv=(env:Record<string,string>)=>Object.keys(env).sort().map(k=>k+'='+JSON.stringify(env[k])).join('\n')+'\n';
export function defaultConfigDir(env: NodeJS.ProcessEnv=process.env) { return resolve(env.SKF_CONFIG_DIR || join(env.LOCALAPPDATA || join(homedir(),'.local','share'),'SKF','config')); }
export function defaultDataDir(env: NodeJS.ProcessEnv=process.env) { return resolve(join(env.LOCALAPPDATA || join(homedir(),'.local','share'),'SKF','data')); }
export function rejectLinks(path: string) { let p=resolve(path); for(;;){if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('CONFIG_LINK_FORBIDDEN');const parent=dirname(p);if(parent===p)break;p=parent;} }
export function securePath(path: string, verify = false) {
  rejectLinks(path);
  if(process.platform==='win32'){
    const script=resolve(dirname(fileURLToPath(import.meta.url)),'../../scripts/config-acl.ps1');
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Path',path,...(verify?['-Verify']:[])],{windowsHide:true,encoding:'utf8',timeout:15000});
    if(r.status!==0||!r.stdout?.includes('ACL_OK'))fail('CONFIG_ACL_UNSAFE');
  }else{const mode=lstatSync(path).isDirectory()?0o700:0o600;if(!verify)chmodSync(path,mode);if((lstatSync(path).mode&0o777)!==mode)fail('CONFIG_ACL_UNSAFE');}
}
export function privateDirectory(path:string){rejectLinks(path);mkdirSync(path,{recursive:true,mode:0o700});securePath(path);}
export async function atomicPrivate(path:string,content:string){
  const temp=join(dirname(path),'.tmp-'+randomUUID());let fd:number|undefined;
  try{fd=openSync(temp,'wx',0o600);securePath(temp);writeSync(fd,content,undefined,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    for(let i=0;;i++){try{renameSync(temp,path);break;}catch{if(i===5)fail('CONFIG_REPLACE_FAILED');await new Promise(r=>setTimeout(r,25*2**i));}}
    if(process.platform!=='win32'){const d=openSync(dirname(path),'r');try{fsyncSync(d);}finally{closeSync(d);}}
  }finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
}
export class FileLock {
  private nonce=randomUUID();private held=false;
  constructor(public path:string){}
  acquire(){
    rejectLinks(this.path);let fd:number;
    try{fd=openSync(this.path,'wx',0o600);}catch{
      // Serialize stale-owner reclamation so two contenders cannot unlink a newly acquired lock.
      const reclaim=this.path+'.reclaim';let gate:number;try{gate=openSync(reclaim,'wx',0o600);}catch{return fail('CONFIG_LOCKED');}
      try{
        let owner:{pid?:number;nonce?:string};try{owner=JSON.parse(readFileSync(this.path,'utf8'));}catch{return fail('CONFIG_LOCKED');}
        if(!Number.isSafeInteger(owner.pid)||!owner.nonce)fail('CONFIG_LOCKED');
        try{process.kill(owner.pid!,0);return fail('CONFIG_LOCKED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return fail('CONFIG_LOCKED');}
        if(readFileSync(this.path,'utf8')!==JSON.stringify(owner))fail('CONFIG_LOCKED');unlinkSync(this.path);
        try{fd=openSync(this.path,'wx',0o600);}catch{return fail('CONFIG_LOCKED');}
      }finally{closeSync(gate);unlinkSync(reclaim);}
    }
    try{writeSync(fd,JSON.stringify({pid:process.pid,nonce:this.nonce}));fsyncSync(fd);this.held=true;}finally{closeSync(fd);}
  }
  release(){if(!this.held)return;try{const owner=JSON.parse(readFileSync(this.path,'utf8'));if(owner.nonce===this.nonce&&owner.pid===process.pid)unlinkSync(this.path);}finally{this.held=false;}}
}
export function maskCredential(key:string|undefined){return key?'********':null;}
export class ConfigService {
  readonly dir:string;private env:NodeJS.ProcessEnv;private overrides:{dataDir?:string};private lease:FileLock|null=null;private queue:Promise<unknown>=Promise.resolve();
  constructor(opts:{configDir?:string;env?:NodeJS.ProcessEnv;dataDir?:string}={}){this.env=opts.env||process.env;this.dir=resolve(opts.configDir||defaultConfigDir(this.env));this.overrides={dataDir:opts.dataDir};rejectLinks(this.dir);}
  read():Registry{const file=join(this.dir,'models.json');if(!existsSync(file))return empty();try{return validateRegistry(JSON.parse(readFileSync(file,'utf8')));}catch(e){if(e instanceof ConfigError)throw e;return fail('CONFIG_INVALID');}}
  private secrets():Record<string,string>{const f=join(this.dir,'config.env');if(!existsSync(f))return {};securePath(f,true);return parseEnv(readFileSync(f,'utf8'));}
  paths(){const f=join(this.dir,'config.env');const file=existsSync(f)?this.secrets():{};const dataDir=resolve(this.overrides.dataDir||this.env.SKF_DATA_DIR||file.SKF_DATA_DIR||defaultDataDir(this.env));return{configDir:this.dir,dataDir,memoryRoot:resolve(this.env.SKF_MEMORY_ROOT||file.SKF_MEMORY_ROOT||join(dataDir,'memory')),source:this.overrides.dataDir?'parameter':this.env.SKF_DATA_DIR?'environment':file.SKF_DATA_DIR?'file':'default'};}
  status(){const r=this.read();const aliases=Object.values(presets).map(p=>p.alias).filter(a=>a&&this.env[a]);const locations=[join(process.cwd(),'.env'),join(homedir(),'.skf','config','config.env'),...(this.env.SKF_DATA_DIR?[join(this.env.SKF_DATA_DIR,'config','config.env')]:[])].filter(p=>existsSync(p)&&resolve(p)!==join(this.dir,'config.env'));return{protocol:MANAGEMENT_PROTOCOL,schemaVersion:CONFIG_SCHEMA,revision:r.revision,configured:!!r.defaultModelRef,defaultModelRef:r.defaultModelRef,...this.paths(),overrides:Object.keys(this.env).filter(k=>(k.startsWith('SKF_CREDENTIAL_')||['SKF_DATA_DIR','SKF_MEMORY_ROOT'].includes(k))&&this.env[k]).map(name=>({name,source:'environment'})),legacy:{locations,aliases,warning:aliases.length||locations.length?'LEGACY_MIGRATION_REQUIRES_REVIEW':null},authority:'models.json',capabilityAuthorizationChanged:false};}
  providers(){return this.read().providers.map(p=>({...p,credentialMask:maskCredential(this.credential(p)),credentialSource:this.credentialSource(p)}));}
  private credentialSource(p:ProviderRecord){return p.credentialRef&&this.env[p.credentialRef]?'environment':p.credentialRef?'file':'none';}
  credential(p:ProviderRecord):string|undefined {if(!p.credentialRef)return undefined;return this.env[p.credentialRef]??this.secrets()[p.credentialRef];}
  model(idValue:string){const r=this.read(),m=r.models.find(m=>m.id===idValue)||fail('MODEL_NOT_FOUND'),p=r.providers.find(p=>p.id===m.providerId)||fail('PROVIDER_NOT_FOUND');return{model:m,provider:p};}
  async ownWriter(){if(this.lease)fail('CONFIG_LOCKED');privateDirectory(this.dir);const l=new FileLock(join(this.dir,'writer.lock'));l.acquire();this.lease=l;try{await this.recover();}catch(e){this.releaseWriter();throw e;}}
  releaseWriter(){this.lease?.release();this.lease=null;}
  async recover(){const marker=join(this.dir,'commit.json');if(existsSync(marker)){const r=this.read(),e=this.secrets();const refs=new Set(r.providers.map(p=>p.credentialRef));for(const k of Object.keys(e))if(k.startsWith('SKF_CREDENTIAL_')&&!refs.has(k))delete e[k];await atomicPrivate(join(this.dir,'config.env'),serializeEnv(e));unlinkSync(marker);}for(const f of readdirSync(this.dir))if(/^\.tmp-[0-9a-f-]+$/.test(f))unlinkSync(join(this.dir,f));}
  /**
   * 一次性把旧配置（config.env 里的 provider key + XIAOLIU_PROVIDER）迁移成 models.json，
   * 让 M27 之前就配好 key 的老用户无需重新 onboard 即可直接使用。
   * 需要已持有 writer 租约（serve() 在 ownWriter 之后调用）。返回是否已有可用配置。
   */
  async bootstrapFromLegacy():Promise<boolean>{
    if(this.read().defaultModelRef)return true;
    const legacy:Record<string,string>={};
    const dataDir=this.env.SKF_DATA_DIR;
    for(const p of [...(dataDir?[join(dataDir,'config','config.env'),join(dataDir,'config.env')]:[]),join(this.dir,'config.env')]){
      if(!existsSync(p))continue;
      try{Object.assign(legacy,parseEnv(readFileSync(p,'utf8')));}catch{break;}
    }
    const get=(n:string)=>this.env[n]??legacy[n];
    const pref=(get('XIAOLIU_PROVIDER')||'').trim().toLowerCase();
    const order:string[]=[];for(const a of [pref,'kimi','deepseek','openai'])if(a&&Object.hasOwn(presets,a)&&!order.includes(a))order.push(a);
    const e:Record<string,string>={...this.secrets(),SKF_CONFIG_VERSION:String(CONFIG_SCHEMA)};
    const providers:ProviderRecord[]=[];const models:ModelRecord[]=[];
    for(const a of order){const preset=presets[a as Adapter];if(!preset.alias)continue;const key=get(preset.alias);if(!key||key.length<20)continue;const ref='SKF_CREDENTIAL_'+randomUUID().replace(/-/g,'').toUpperCase();e[ref]=key;providers.push({id:a,name:a,adapter:a as Adapter,baseUrl:preset.baseUrl,credentialRef:ref});models.push({id:a,providerId:a,modelId:preset.model,tools:true,vision:false,contextWindowTokens:null});}
    if(!providers.length)return false;
    const dflt=models.find(m=>m.providerId===pref)?.id||models[0].id;
    e.SKF_DATA_DIR=resolve(dataDir||this.paths().dataDir).replace(/\\/g,'/');
    e.SKF_MEMORY_ROOT=resolve(get('SKF_MEMORY_ROOT')||join(e.SKF_DATA_DIR,'memory')).replace(/\\/g,'/');
    const reg:Registry={schemaVersion:CONFIG_SCHEMA,revision:1,providers,models,defaultModelRef:dflt};
    validateRegistry(reg);
    privateDirectory(this.dir);
    await atomicPrivate(join(this.dir,'config.env'),serializeEnv(e));
    await atomicPrivate(join(this.dir,'models.json'),JSON.stringify(reg,null,2)+'\n');
    return true;
  }
  commit(expectedRevision:number,command:ConfigCommand):Promise<Registry>{const run=this.queue.then(()=>this.commitLocked(expectedRevision,command));this.queue=run.catch(()=>undefined);return run;}
  private async commitLocked(expectedRevision:number,command:ConfigCommand){
    const temporary=!this.lease;if(temporary)await this.ownWriter();
    try{await this.recover();const old=this.read();if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==old.revision)fail('CONFIG_REVISION_CONFLICT');const r=structuredClone(old),e=this.secrets();e.SKF_CONFIG_VERSION=String(CONFIG_SCHEMA);
      const find=(pid:string)=>r.providers.find(p=>p.id===pid)||fail('PROVIDER_NOT_FOUND');
      const putKey=(p:ProviderRecord,key:string|undefined,ack=false)=>{if(key===undefined)return;if(p.credentialRef&&this.env[p.credentialRef]!==undefined)fail('CREDENTIAL_ENV_OVERRIDE');safeText(key,8192);const official=presets[p.adapter].baseUrl;if(!loopback(new URL(p.baseUrl).hostname)&&p.baseUrl!==official&&!ack)fail('CUSTOM_ENDPOINT_CONFIRM_REQUIRED');const ref='SKF_CREDENTIAL_'+randomUUID().replace(/-/g,'').toUpperCase();e[ref]=key;p.credentialRef=ref;};
      switch(command.type){
        case 'setup':{const p=validateProvider(command.provider);if(p.credentialRef)fail('CREDENTIAL_REF_FORBIDDEN');const m=validateModel(command.model);if(m.providerId!==p.id)fail('CONFIG_REFERENCE_INVALID');if(r.providers.some(x=>x.id===p.id)||r.models.some(x=>x.id===m.id))fail('CONFIG_DUPLICATE');putKey(p,command.key,command.acknowledgeCustomEndpoint);if(old.revision===0&&[join(command.dataDir,'runtime.sqlite'),join(command.dataDir,'runtime','runtime.sqlite')].some(existsSync))fail('DATA_MIGRATION_REVIEW_REQUIRED');this.checkDataDir(command.dataDir);if(old.revision&&this.paths().dataDir!==resolve(command.dataDir))fail('DATA_MIGRATION_REQUIRED');e.SKF_DATA_DIR=resolve(command.dataDir).replace(/\\/g,'/');e.SKF_MEMORY_ROOT=join(command.dataDir,'memory').replace(/\\/g,'/');r.providers.push(p);r.models.push(m);r.defaultModelRef=m.id;break;}
        case 'provider.add':{const p=validateProvider(command.provider);if(p.credentialRef)fail('CREDENTIAL_REF_FORBIDDEN');if(r.providers.some(x=>x.id===p.id))fail('CONFIG_DUPLICATE');putKey(p,command.key,command.acknowledgeCustomEndpoint);r.providers.push(p);break;}
        case 'provider.edit':{const p=find(command.id),patch=object(command.patch);fields(patch,['name','baseUrl']);if(patch.baseUrl&&endpoint(patch.baseUrl)!==p.baseUrl){if(p.credentialRef&&!command.acknowledgeCredentialRemoval)fail('ENDPOINT_CREDENTIAL_RESET_REQUIRED');delete p.credentialRef;for(const m of r.models.filter(m=>m.providerId===p.id))delete m.lastTest;}Object.assign(p,validateProvider({...p,...patch}));break;}
        case 'provider.key':putKey(find(command.id),command.key,command.acknowledgeCustomEndpoint);for(const m of r.models.filter(m=>m.providerId===command.id))delete m.lastTest;break;
        case 'provider.remove':find(command.id);if(r.models.some(m=>m.providerId===command.id))fail('PROVIDER_IN_USE');r.providers=r.providers.filter(p=>p.id!==command.id);break;
        case 'model.add':{const m=validateModel(command.model);find(m.providerId);if(r.models.some(x=>x.id===m.id))fail('CONFIG_DUPLICATE');r.models.push(m);break;}
        case 'model.edit':{const i=r.models.findIndex(m=>m.id===command.id);if(i<0)fail('MODEL_NOT_FOUND');const patch=object(command.patch);fields(patch,['modelId','tools','vision','contextWindowTokens']);r.models[i]=validateModel({...r.models[i],...patch,lastTest:undefined});break;}
        case 'model.remove':if(!r.models.some(m=>m.id===command.id))fail('MODEL_NOT_FOUND');if(r.defaultModelRef===command.id)fail('DEFAULT_MODEL_IN_USE');r.models=r.models.filter(m=>m.id!==command.id);break;
        case 'model.default':if(!r.models.some(m=>m.id===command.id))fail('MODEL_NOT_FOUND');r.defaultModelRef=command.id;break;
        case 'model.test-result':{const m=r.models.find(m=>m.id===command.id)||fail('MODEL_NOT_FOUND');m.lastTest=command.result;break;}
        default:fail('CONFIG_COMMAND_INVALID');
      }
      r.revision++;validateRegistry(r);
      // Credentials use fresh references. Old registry remains usable until its atomic replacement.
      await atomicPrivate(join(this.dir,'commit.json'),JSON.stringify({from:old.revision,to:r.revision}));
      await atomicPrivate(join(this.dir,'config.env'),serializeEnv(e));
      await atomicPrivate(join(this.dir,'models.json'),JSON.stringify(r,null,2)+'\n');
      await this.recover();return r;
    }finally{if(temporary)this.releaseWriter();}
  }
  checkDataDir(value:string){safeText(value,2048);if(!isAbsolute(value)||/^\\\\|^\/\//.test(value)||/(^|[\\/])OneDrive([\\/ -]|$)/i.test(value))fail('DATA_LOCAL_PATH_REQUIRED');rejectLinks(value);mkdirSync(value,{recursive:true,mode:0o700});const dir=realpathSync(value);securePath(dir);const s=statfsSync(dir);if(s.bavail*s.bsize<10*1024*1024)fail('DATA_DISK_FULL');const probe=join(dir,'.write-'+randomUUID());const fd=openSync(probe,'wx',0o600);closeSync(fd);unlinkSync(probe);return dir;}
}
