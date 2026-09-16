import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { ConfigError, MANAGEMENT_PROTOCOL, CONFIG_SCHEMA, fail, rejectLinks } from './config-service.js';
import { ManagementService } from './management-service.js';
export interface RpcRequest { id:string;action:string;protocol?:number;data?:Record<string,unknown> }
const random=()=>randomBytes(32).toString('base64url');
const equal=(a:unknown,b:string)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class ManagementHttp {
  private localSecret=random();private instanceId=random();private url='';
  private sessions=new Map<string,{csrf:string;expires:number}>();private pairings=new Map<string,number>();private pairingAttempts:{at:number;n:number}={at:0,n:0};
  private server=createServer((req,res)=>{void this.handle(req,res);});
  constructor(readonly service:ManagementService,private options:{uiDir:string;rpc?:(req:RpcRequest)=>Promise<unknown>;stop?:()=>Promise<void>;state?:()=>unknown}){this.server.requestTimeout=30000;this.server.headersTimeout=15000;this.server.maxHeadersCount=40;}
  async listen(port=0){await new Promise<void>((ok,no)=>{this.server.once('error',no);this.server.listen(port,'127.0.0.1',()=>{this.server.off('error',no);ok();});});const addr=this.server.address();if(!addr||typeof addr==='string')fail('HTTP_START_FAILED');this.url='http://127.0.0.1:'+addr.port;return{url:this.url,localSecret:this.localSecret,instanceId:this.instanceId,protocol:MANAGEMENT_PROTOCOL,schemaVersion:CONFIG_SCHEMA,pid:process.pid};}
  async close(){this.sessions.clear();this.pairings.clear();this.server.closeIdleConnections();await new Promise<void>((ok)=>this.server.close(()=>ok()));}
  private json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
  private async body(req:IncomingMessage){if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('CONTENT_TYPE_REQUIRED');let size=0;const chunks:Buffer[]=[];for await(const c of req){size+=c.length;if(size>65536)fail('REQUEST_TOO_LARGE');chunks.push(c);}try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_INPUT');return body as Record<string,unknown>;}catch{return fail('INVALID_INPUT');}}
  private async handle(req:IncomingMessage,res:ServerResponse){
    try{
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
      if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1')fail('LOOPBACK_REQUIRED');
      if(req.headers.host!==new URL(this.url).host)fail('HOST_REJECTED');
      if(req.headers.origin&&req.headers.origin!==this.url)fail('ORIGIN_REJECTED');
      if(req.headers['sec-fetch-site']==='cross-site')fail('ORIGIN_REJECTED');
      const path=req.url||'/',method=req.method||'GET';if(path.includes('?')||path.includes('#'))fail('INVALID_PATH');
      if(!path.startsWith('/v1/')){if(method!=='GET')fail('METHOD_DENIED');return this.static(path,res);}
      if(Number(req.headers['x-skf-protocol'])!==MANAGEMENT_PROTOCOL)fail('MANAGEMENT_PROTOCOL_UNSUPPORTED');
      const local=equal(req.headers.authorization,'Bearer '+this.localSecret);
      const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('skf_session='))?.slice(12)||'';
      let session=this.sessions.get(cookie);if(session&&session.expires<Date.now()){this.sessions.delete(cookie);session=undefined;}
      if(path==='/v1/pair'&&method==='POST'){
        if(req.headers.origin!==this.url)fail('ORIGIN_REJECTED');if(Date.now()-this.pairingAttempts.at>60000)this.pairingAttempts={at:Date.now(),n:0};if(++this.pairingAttempts.n>6)fail('PAIRING_RATE_LIMITED');
        const body=await this.body(req);const code=typeof body.code==='string'?body.code:'';const expires=this.pairings.get(code);this.pairings.delete(code);if(!expires||expires<Date.now())fail('PAIRING_REJECTED');
        const token=random(),csrf=random();this.sessions.set(token,{csrf,expires:Date.now()+3600000});res.setHeader('Set-Cookie','skf_session='+token+'; HttpOnly; SameSite=Strict; Path=/');return this.json(res,200,{csrf,protocol:MANAGEMENT_PROTOCOL});
      }
      if(!local&&!session)fail('AUTH_REQUIRED');
      if(!local&&method!=='GET'&&(req.headers.origin!==this.url||!equal(req.headers['x-skf-csrf'],session!.csrf)))fail('CSRF_REJECTED');
      if(path==='/v1/session'&&method==='GET')return this.json(res,200,{csrf:session?.csrf||null,protocol:MANAGEMENT_PROTOCOL});
      if(path==='/v1/handshake'&&method==='GET')return this.json(res,200,{protocol:MANAGEMENT_PROTOCOL,schemaVersion:CONFIG_SCHEMA,instanceId:this.instanceId,...(this.options.state?{state:this.options.state()}:{})});
      if(path==='/v1/pairing/new'&&method==='POST'){if(!local)fail('LOCAL_CLIENT_REQUIRED');for(const [c,e]of this.pairings)if(e<Date.now())this.pairings.delete(c);if(this.pairings.size>=10)fail('PAIRING_RATE_LIMITED');const code=random();this.pairings.set(code,Date.now()+120000);return this.json(res,200,{code,expiresInSeconds:120});}
      const body=method==='GET'?{}:await this.body(req);
      if(path==='/v1/rpc'&&method==='POST'){if(!this.options.rpc)fail('CORE_NOT_READY');const result=await this.options.rpc(body as unknown as RpcRequest);return this.json(res,200,result);}
      if(path==='/v1/stop'&&method==='POST'){if(!local)fail('LOCAL_CLIENT_REQUIRED');if(!this.options.stop)fail('STOP_UNAVAILABLE');await this.options.stop();this.json(res,200,{stopped:true});return;}
      const result=await this.service.route(method,path,body,MANAGEMENT_PROTOCOL);this.json(res,200,result);
    }catch(e){const code=e instanceof ConfigError?e.code:'MANAGEMENT_FAILED';this.json(res,code==='CONFIG_REVISION_CONFLICT'?409:code==='AUTH_REQUIRED'?401:/PROTOCOL|SCHEMA/.test(code)?426:/REJECTED|REQUIRED/.test(code)?403:400,{error:code});}
  }
  private static(path:string,res:ServerResponse){
    if(path==='/'||path==='/index.html')path='/index.html';
    if(!/^\/[a-zA-Z0-9._/-]+$/.test(path)||path.includes('..'))fail('NOT_FOUND');
    const root=resolve(this.options.uiDir),file=resolve(root,'.'+path);if(!file.startsWith(root+sep)||!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail('NOT_FOUND');
    rejectLinks(file);
    const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};const type=types[extname(file)];if(!type)fail('NOT_FOUND');
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(readFileSync(file));
  }
}
