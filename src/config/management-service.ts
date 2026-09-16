import { ConfigService, ConfigError, MANAGEMENT_PROTOCOL, endpoint, loopback, fail, presets, validateProvider, validateModel, type ConfigCommand, type ModelRecord, type ProviderRecord } from './config-service.js';
import { mapCompletionResponse, toOpenAIMessages, toOpenAITools, type CompletionRequest, type CompletionResult, type ProviderAdapter, type ProviderCapabilities } from '../providers/protocol.js';

export async function providerRequest(service:ConfigService,provider:ProviderRecord,path:string,body?:unknown,signal?:AbortSignal):Promise<unknown>{
  const url=endpoint(provider.baseUrl)+path;let key=service.credential(provider);let response:Response;
  try{response=await fetch(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:signal||AbortSignal.timeout(20000),headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
  catch{return fail(signal?.aborted?'PROVIDER_ABORTED':'PROVIDER_UNREACHABLE');}finally{key=undefined;}
  if(!response.ok){void response.body?.cancel();return fail(response.status===401||response.status===403?'PROVIDER_AUTH_FAILED':response.status===429?'PROVIDER_RATE_LIMITED':response.status>=500?'PROVIDER_SERVER_ERROR':'PROVIDER_BAD_REQUEST');}
  const reader=response.body?.getReader();if(!reader)return fail('PROVIDER_INVALID_RESPONSE');let size=0;const chunks:Uint8Array[]=[];try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024){await reader.cancel();return fail('PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(r.value);}const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));let credential=service.credential(provider);try{const clean=(value:unknown):unknown=>typeof value==='string'&&credential?value.split(credential).join('[REDACTED]'):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])):value;return clean(parsed);}finally{credential=undefined;}}catch{return fail('PROVIDER_INVALID_RESPONSE');}
}
export class ManagedAdapter implements ProviderAdapter {
  constructor(private config:ConfigService,readonly record:ModelRecord,readonly provider:ProviderRecord){}
  async capabilities():Promise<ProviderCapabilities>{return{tools:this.record.tools,streaming:false,cancel:true,usage:true,contextWindowTokens:this.record.contextWindowTokens};}
  async complete(req:CompletionRequest):Promise<CompletionResult>{
    const reasoning=this.provider.adapter==='kimi'||this.provider.adapter==='deepseek';
    const remaining=req.deadlineAt-Date.now();if(remaining<=0)fail('PROVIDER_DEADLINE_EXCEEDED');
    const current=this.config.read().providers.find(p=>p.id===this.provider.id);
    // Key replacement can take effect; endpoint or provider identity never silently changes for a bound adapter.
    const p=current&&current.baseUrl===this.provider.baseUrl&&current.adapter===this.provider.adapter?current:fail('MODEL_BINDING_CHANGED');
    const raw=await providerRequest(this.config,p,'/chat/completions',{model:this.record.modelId,messages:toOpenAIMessages(req.messages,{reasoning}),[p.adapter==='openai'?'max_completion_tokens':'max_tokens']:req.maxOutputTokens,...(req.tools.length?{tools:toOpenAITools(req.tools),tool_choice:'auto'}:{})},AbortSignal.any([req.signal,AbortSignal.timeout(remaining)]));
    try{return mapCompletionResponse(raw,{provider:'managed:'+this.record.id,model:this.record.modelId,maxTokensParam:'max_tokens'});}catch{return fail('PROVIDER_INVALID_RESPONSE');}
  }
}
export class ManagementService {
  constructor(readonly config:ConfigService,private changed?:()=>void|Promise<void>){}
  async command(expectedRevision:number,command:ConfigCommand){const result=await this.config.commit(expectedRevision,command);await this.changed?.();return {revision:result.revision};}
  async discover(id:string){const p=this.config.read().providers.find(p=>p.id===id)||fail('PROVIDER_NOT_FOUND');const raw=await providerRequest(this.config,p,'/models') as {data?:Array<{id?:unknown}>};if(!Array.isArray(raw?.data))fail('PROVIDER_INVALID_RESPONSE');return{models:raw.data.slice(0,1000).map(m=>m.id).filter((m):m is string=>typeof m==='string'&&m.length<=200&&!/[\x00-\x1f]/.test(m))};}
  async test(id:string,inference:boolean,consent:boolean,expectedRevision:number){
    const {model,provider}=this.config.model(id);if(this.config.read().revision!==expectedRevision)fail('CONFIG_REVISION_CONFLICT');
    if(inference&&!loopback(new URL(provider.baseUrl).hostname)&&!consent)fail('PAID_TEST_CONFIRM_REQUIRED');
    const start=Date.now();let code='OK';try{if(inference){const a=new ManagedAdapter(this.config,model,provider);await a.complete({callId:'setup-test',taskId:'setup-test',messages:[{role:'user',content:'Reply OK.'}],tools:[],maxOutputTokens:8,signal:AbortSignal.timeout(20000),deadlineAt:Date.now()+20000});}else{const found=await this.discover(provider.id);if(!found.models.includes(model.modelId))fail('MODEL_NOT_DISCOVERED');}}catch(e){code=e instanceof ConfigError?e.code:'PROVIDER_UNREACHABLE';}
    const result={code,at:new Date().toISOString(),latencyMs:Date.now()-start,inference};await this.command(expectedRevision,{type:'model.test-result',id,result});return{...result,revision:this.config.read().revision};
  }
  async route(method:string,path:string,body:Record<string,unknown>={},protocol=MANAGEMENT_PROTOCOL):Promise<unknown>{
    if(protocol!==MANAGEMENT_PROTOCOL)fail('MANAGEMENT_PROTOCOL_UNSUPPORTED');
    if(method==='GET'){
      if(path==='/v1/setup/status')return this.config.status();
      if(path==='/v1/providers')return{providers:this.config.providers(),revision:this.config.read().revision};
      if(path==='/v1/models')return this.config.read();
    }
    if(!Number.isSafeInteger(body.expectedRevision))fail('EXPECTED_REVISION_REQUIRED');
    const rev=body.expectedRevision as number;const cmd=(command:ConfigCommand)=>this.command(rev,command);
    if(method==='POST'&&(path==='/v1/setup/discover'||path==='/v1/setup/test')){
      if(this.config.read().revision!==rev)fail('CONFIG_REVISION_CONFLICT');
      const provider=validateProvider(body.provider);if(provider.credentialRef)fail('CREDENTIAL_REF_FORBIDDEN');
      let key=body.key as string|undefined;
      if(key!==undefined&&(typeof key!=='string'||key.length>8192||/[\x00-\x1f\x7f]/.test(key)))fail('CONFIG_INVALID');
      if(key&&!loopback(new URL(provider.baseUrl).hostname)&&provider.baseUrl!==presets[provider.adapter].baseUrl&&body.acknowledgeCustomEndpoint!==true)fail('CUSTOM_ENDPOINT_CONFIRM_REQUIRED');
      const draft=new class extends ConfigService { override credential(){return key;} }({configDir:this.config.dir,env:{}});
      try{
        if(path.endsWith('/discover')){const raw=await providerRequest(draft,provider,'/models') as {data?:Array<{id?:unknown}>};if(!Array.isArray(raw?.data))fail('PROVIDER_INVALID_RESPONSE');return{models:raw.data.slice(0,1000).map(m=>m.id).filter(m=>typeof m==='string'&&m.length<201&&!/[\x00-\x1f]/.test(m))};}
        if(!loopback(new URL(provider.baseUrl).hostname)&&body.confirmPaid!==true)fail('PAID_TEST_CONFIRM_REQUIRED');
        const model=validateModel(body.model);const start=Date.now();let code='OK';
        try{const raw=await providerRequest(draft,provider,'/chat/completions',{model:model.modelId,messages:[{role:'user',content:'Reply OK.'}],[provider.adapter==='openai'?'max_completion_tokens':'max_tokens']:8});mapCompletionResponse(raw,{provider:provider.id,model:model.modelId,maxTokensParam:'max_tokens'});}catch(e){code=e instanceof ConfigError?e.code:'PROVIDER_INVALID_RESPONSE';}
        return{code,at:new Date().toISOString(),latencyMs:Date.now()-start,inference:true};
      }finally{key=undefined;body.key=undefined;}
    }
    if(method==='POST'&&path==='/v1/setup/commit')return cmd({type:'setup',provider:body.provider,model:body.model,key:body.key as string|undefined,dataDir:body.dataDir as string,acknowledgeCustomEndpoint:body.acknowledgeCustomEndpoint===true});
    if(method==='POST'&&path==='/v1/providers')return cmd({type:'provider.add',provider:body.provider,key:body.key as string|undefined,acknowledgeCustomEndpoint:body.acknowledgeCustomEndpoint===true});
    if(method==='POST'&&path==='/v1/models')return cmd({type:'model.add',model:body.model});
    if(method==='PUT'&&path==='/v1/models/default')return cmd({type:'model.default',id:String(body.id)});
    const p=/^\/v1\/providers\/([a-z0-9_-]+)(\/credential|\/test|\/discover)?$/.exec(path);
    if(p){if(method==='PUT'&&p[2]==='/credential')return cmd({type:'provider.key',id:p[1],key:body.key as string,acknowledgeCustomEndpoint:body.acknowledgeCustomEndpoint===true});if(method==='PATCH'&&!p[2])return cmd({type:'provider.edit',id:p[1],patch:body.patch,acknowledgeCredentialRemoval:body.acknowledgeCredentialRemoval===true});if(method==='DELETE'&&!p[2])return cmd({type:'provider.remove',id:p[1]});if(method==='POST'&&p[2]==='/discover')return this.discover(p[1]);if(method==='POST'&&p[2]==='/test'){const model=this.config.read().models.find(m=>m.providerId===p[1])||fail('MODEL_NOT_FOUND');return this.test(model.id,body.inference===true,body.confirmPaid===true,rev);}}
    const m=/^\/v1\/models\/([a-z0-9_-]+)(\/test)?$/.exec(path);
    if(m){if(method==='PATCH'&&!m[2])return cmd({type:'model.edit',id:m[1],patch:body.patch});if(method==='DELETE'&&!m[2])return cmd({type:'model.remove',id:m[1]});if(method==='POST'&&m[2]==='/test')return this.test(m[1],body.inference===true,body.confirmPaid===true,rev);}
    return fail('MANAGEMENT_NOT_FOUND');
  }
}
