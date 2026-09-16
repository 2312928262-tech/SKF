import { createHash } from 'node:crypto';
import type { RuntimeStore } from '../runtime/runtime-store.js';
import type { ModelGateway } from '../runtime/model-gateway.js';
import type { Brain } from '../brain.js';
import { ConfigService, loopback, fail, type ModelRecord, type ProviderRecord } from './config-service.js';
import { ManagedAdapter } from './management-service.js';
import type { ProviderName, ThinkRequest } from '../providers/types.js';
import { thinkViaComplete } from '../providers/think-compat.js';
export class ManagedModels {
  constructor(readonly config:ConfigService,private store:RuntimeStore,private brain:Brain,private gateway:ModelGateway){store.db.exec('CREATE TABLE IF NOT EXISTS model_session_bindings (sessionId TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');}
  private name(model:ModelRecord,provider:ProviderRecord):ProviderName {return ('managed:'+model.id+':'+createHash('sha256').update(JSON.stringify([provider.id,provider.adapter,provider.baseUrl,model.modelId,model.tools,model.vision,model.contextWindowTokens])).digest('hex').slice(0,12)) as ProviderName;}
  private async register(model:ModelRecord,provider:ProviderRecord){const name=this.name(model,provider);if(!this.brain.adapterFor(name)){const adapter=new ManagedAdapter(this.config,model,provider);const p={name,modelName:model.modelId,capabilities:()=>adapter.capabilities(),complete:adapter.complete.bind(adapter),think:(req:ThinkRequest)=>thinkViaComplete(name,model.modelId,adapter,req,{timeoutMs:300000}),isReady:async()=>true};this.brain.registerManaged(p);await this.brain.capabilitiesFor(name);this.gateway.registerProvider({name,model:model.modelId,adapter:p,local:loopback(new URL(provider.baseUrl).hostname),verified:true});}return name;}
  async refresh(){const r=this.config.read();for(const m of r.models){const p=r.providers.find(p=>p.id===m.providerId)!;await this.register(m,p);}if(r.defaultModelRef){const m=r.models.find(m=>m.id===r.defaultModelRef)!;this.brain.setProvider(this.name(m,r.providers.find(p=>p.id===m.providerId)!));}}
  async bind(sessionId:string){const existing=this.store.db.prepare('SELECT snapshot FROM model_session_bindings WHERE sessionId=?').get(sessionId) as {snapshot:string}|undefined;if(existing){const {model,provider}=JSON.parse(existing.snapshot) as {model:ModelRecord;provider:ProviderRecord};return this.register(model,provider);}const r=this.config.read();const model=r.models.find(m=>m.id===r.defaultModelRef)||fail('SETUP_REQUIRED');const provider=r.providers.find(p=>p.id===model.providerId)!;const snapshot=JSON.stringify({model,provider});this.store.db.prepare('INSERT OR IGNORE INTO model_session_bindings(sessionId,snapshot) VALUES (?,?)').run(sessionId,snapshot);return this.register(model,provider);}
}
