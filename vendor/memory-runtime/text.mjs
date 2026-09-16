import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function redact(text) {
  const safe=String(text).replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,'[已省略凭据相关内容]');
  return safe.split(/\r?\n/).map(line => {
    if (/(?:password|passwd|密码)\s*(?:[:：=，]|["'`])|(?:api[_ -]?key|access[_ -]?token|authorization|secret)\s*[:=：]\s*["'`]?[^\s]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY-----/i.test(line)) return '[已省略凭据相关内容]';
    return line;
  }).join('\n');
}
export function terms(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) || [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = [...run];
    for (let i=0; i<chars.length-1; i++) tokens.push(chars[i]+chars[i+1]);
    if (chars.length===1) tokens.push(chars[0]);
  }
  return tokens.filter(t => !['这个','一个','什么','一下','帮我','可以','需要','怎么','我们','现在'].includes(t));
}
export const units = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
export function clip(text, maxBytes) {
  if (units(text) <= maxBytes) return { text, truncated:false };
  const mark = '\n[片段已截短；完整内容见来源]\n';
  if (maxBytes < units(mark)) return { text:'', truncated:true };
  const chars=[...text]; let low=0, high=chars.length;
  while(low<high){ const n=Math.ceil((low+high)/2), a=Math.ceil(n*0.7), b=n-a;
    const candidate=chars.slice(0,a).join('')+mark+(b?chars.slice(-b).join(''):'');
    if(units(candidate)<=maxBytes)low=n;else high=n-1;
  }
  const a=Math.ceil(low*0.7), b=low-a;
  return {text:chars.slice(0,a).join('')+mark+(b?chars.slice(-b).join(''):''),truncated:true};
}
export function chunks(text, maxChars=650) {
  const result=[]; let buffer='', start=1, line=1;
  for(const paragraph of redact(text).split(/\n\s*\n/)) {
    if(buffer && buffer.length+paragraph.length>maxChars){result.push({text:buffer.trim(),line:start});buffer='';start=line;}
    if(paragraph.length>maxChars){if(buffer){result.push({text:buffer.trim(),line:start});buffer='';}
      for(let i=0;i<paragraph.length;i+=maxChars)result.push({text:paragraph.slice(i,i+maxChars),line});start=line;
    }else buffer+=paragraph+'\n\n';
    line+=paragraph.split('\n').length+1;
  }
  if(buffer.trim())result.push({text:buffer.trim(),line:start});
  return result;
}
