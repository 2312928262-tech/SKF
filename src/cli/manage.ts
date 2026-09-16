import { presets, ConfigError, type Adapter, type ModelRecord, type Registry, type ProviderRecord } from '../config/config-service.js';
import { question, confirm, hidden, credentialStdin } from './prompts.js';
export type Call=(method:string,path:string,body?:Record<string,unknown>)=>Promise<unknown>;
const as=<T>(x:unknown)=>x as T;
async function modelForm(providerId:string, existing?:ModelRecord){return{id:existing?.id||await question('Model record ID'),providerId,modelId:await question('Exact model ID',existing?.modelId||''),tools:await confirm('Model tool calling verified? (does NOT grant tool permissions)'),vision:await confirm('Model vision capability verified?'),contextWindowTokens:Number(await question('Documented context tokens; 0 = unknown','0'))||null};}
async function connection(){
  const adapter=await question('Provider: kimi / deepseek / openai / ollama / vllm / compatible','ollama') as Adapter;if(!Object.hasOwn(presets,adapter))throw new ConfigError('ADAPTER_UNSUPPORTED');
  const id=await question('Connection ID',adapter),name=await question('Connection name',id),baseUrl=await question('Endpoint',presets[adapter].baseUrl);
  const custom=baseUrl!==presets[adapter].baseUrl;let acknowledgeCustomEndpoint=false;if(custom){console.log('Custom endpoint: credentials will be sent to THIS server; no official key is reused.');acknowledgeCustomEndpoint=await confirm('Trust this exact endpoint?');if(!acknowledgeCustomEndpoint)throw new ConfigError('ONBOARD_CANCELLED');}
  let key=await hidden(adapter==='ollama'?'API key (optional for Ollama; hidden)':'API key (hidden; local vLLM may be empty)');
  return{provider:{id,name,adapter,baseUrl},key:key||undefined,acknowledgeCustomEndpoint};
}
export async function onboard(call:Call,force=false){
  const status=as<{configured:boolean;revision:number;dataDir:string}>(await call('GET','/v1/setup/status'));
  console.log('0/8 Detect configuration sources:');console.log(JSON.stringify(status,null,2));
  if(status.configured&&!force){console.log('Already configured. Use skf onboard --force to add a replacement connection; existing configuration is preserved.');return;}
  console.log('1-3/8 Provider, endpoint, hidden credential');let draft=await connection();
  console.log('4/8 Model (manual IDs supported)');
  if(await confirm('Attempt authenticated model discovery (no inference)?')){try{console.log(JSON.stringify(await call('POST','/v1/setup/discover',{expectedRevision:status.revision,...draft})));}catch{console.log('Discovery unavailable; enter the exact model ID manually.');}}
  const model=await modelForm(draft.provider.id);
  console.log('5/8 Data directory');const dataDir=await question('Local data directory',status.dataDir);
  console.log('6/8 Inference testing may incur provider charges. Saving offline is allowed.');const test=await confirm('Run a minimal inference BEFORE saving?');
  if(test)console.log(JSON.stringify(await call('POST','/v1/setup/test',{expectedRevision:status.revision,...draft,model,confirmPaid:true})));
  console.log('7/8 Save summary:',JSON.stringify({provider:draft.provider,model,dataDir,credential:draft.key?'********':'none',test:test?'confirmed':'unverified'}));
  if(!await confirm('Commit atomically?')){draft.key=undefined;throw new ConfigError('ONBOARD_CANCELLED');}
  try{await call('POST','/v1/setup/commit',{expectedRevision:status.revision,...draft,model,dataDir});}finally{draft.key=undefined;}
  console.log('8/8 Saved. Default for NEW sessions: '+model.id+(test?'':' (UNVERIFIED)')+'. Next: skf start');
}
export async function modelCommand(args:string[],call:Call){
  const registry=as<Registry>(await call('GET','/v1/models'));const rev=registry.revision;const [action,id]=args;
  switch(action){
    case 'list':console.log(JSON.stringify({models:registry.models,defaultModelRef:registry.defaultModelRef,...as<object>(await call('GET','/v1/providers'))},null,2));break;
    case 'add':{const providerId=await question('Existing connection ID (blank = create connection)');let provider:ProviderRecord|undefined=registry.providers.find(p=>p.id===providerId);let revision=rev;if(providerId&&!provider)throw new ConfigError('PROVIDER_NOT_FOUND');if(!provider){let draft=await connection();try{const result=as<{revision:number}>(await call('POST','/v1/providers',{expectedRevision:revision,...draft}));revision=result.revision;provider=draft.provider;}finally{draft.key=undefined;}}const model=await modelForm(provider.id);await call('POST','/v1/models',{expectedRevision:revision,model});break;}
    case 'remove':await call('DELETE','/v1/models/'+id,{expectedRevision:rev});break;
    case 'set-default':await call('PUT','/v1/models/default',{expectedRevision:rev,id});console.log('Default changed for NEW sessions only.');break;
    case 'test':{console.log('Inference may incur charges. No = protocol/auth/model-list check only.');const inference=await confirm('Run minimal inference?');console.log(JSON.stringify(await call('POST','/v1/models/'+id+'/test',{expectedRevision:rev,inference,confirmPaid:inference})));break;}
    case 'edit':{const m=registry.models.find(m=>m.id===id);if(!m)throw new ConfigError('MODEL_NOT_FOUND');const p=registry.providers.find(p=>p.id===m.providerId)!;const baseUrl=await question('Provider endpoint (change affects all models; old credential will be removed)',p.baseUrl);let revision=rev;if(baseUrl!==p.baseUrl){if(!await confirm('Remove old credential and change endpoint?'))throw new ConfigError('ONBOARD_CANCELLED');revision=as<{revision:number}>(await call('PATCH','/v1/providers/'+p.id,{expectedRevision:rev,patch:{baseUrl},acknowledgeCredentialRemoval:true})).revision;}const {id:_,providerId:__,...patch}=await modelForm(p.id,m);await call('PATCH','/v1/models/'+id,{expectedRevision:revision,patch});break;}
    case 'key':{if(id!=='replace'||!args[2])throw new ConfigError('CLI_USAGE');const p=registry.providers.find(p=>p.id===args[2]);if(!p)throw new ConfigError('PROVIDER_NOT_FOUND');console.log('Replace credential for endpoint: '+p.baseUrl);const dedicated=args.includes('--credential-stdin');const ack=dedicated?args.includes('--trust-endpoint'):await confirm('Trust this endpoint for the new credential?');if(!ack)throw new ConfigError('ONBOARD_CANCELLED');let key=dedicated?await credentialStdin():await hidden();try{await call('PUT','/v1/providers/'+p.id+'/credential',{expectedRevision:rev,key,acknowledgeCustomEndpoint:ack});}finally{key='';}break;}
    case 'provider':if(id!=='remove'||!args[2])throw new ConfigError('CLI_USAGE');await call('DELETE','/v1/providers/'+args[2],{expectedRevision:rev});break;
    default:throw new ConfigError('CLI_USAGE');
  }
}
