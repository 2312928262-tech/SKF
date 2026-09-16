import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ConfigError } from '../config/config-service.js';
export async function question(label:string,fallback=''){if(!stdin.isTTY||!stdout.isTTY)throw new ConfigError('TTY_REQUIRED');const rl=createInterface({input:stdin,output:stdout,terminal:true});try{const answer=await rl.question(label+(fallback?' ['+fallback+']':'')+': ');return answer.trim()||fallback;}finally{rl.close();}}
export async function confirm(label:string){return /^(y|yes|是)$/i.test(await question(label+' [y/N]'));}
export async function credentialStdin():Promise<string> {
  if(stdin.isTTY)throw new ConfigError('DEDICATED_STDIN_REQUIRED');
  let value='';for await(const chunk of stdin){value+=chunk.toString();if(Buffer.byteLength(value)>8192)throw new ConfigError('CREDENTIAL_TOO_LARGE');}
  value=value.replace(/\r?\n$/,'');if(!value||/[\x00-\x1f\x7f]/.test(value))throw new ConfigError('CONFIG_INVALID');return value;
}
export async function hidden(label='API key (hidden; Enter to skip)'):Promise<string>{
  if(!stdin.isTTY||!stdout.isTTY)throw new ConfigError('TTY_REQUIRED');stdout.write(label+': ');
  const previous=stdin.isRaw;stdin.setRawMode(true);stdin.resume();stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{let value='';const done=(cancel=false)=>{stdin.off('data',read);stdin.setRawMode(previous||false);stdin.pause();stdout.write('\n');const result=value;value='';cancel?reject(new ConfigError('ONBOARD_CANCELLED')):resolve(result);};const read=(s:string)=>{for(const c of s){if(c==='\u0003'||c==='\u0004'){done(true);return;}if(c==='\r'||c==='\n'){done();return;}if(c==='\u007f'||c==='\b'){value=[...value].slice(0,-1).join('');continue;}if(c<' '||c==='\u001b')continue;if(value.length<8192)value+=c;}};stdin.on('data',read);});
}
