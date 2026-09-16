import { terms } from './text.mjs';
export function retryIndex(vault,{ids,operationId}={}){
  if(!Array.isArray(ids)||!ids.length)throw new Error('EXPLICIT_RETRY_IDS_REQUIRED');
  return vault.atomic(operationId,{ids},()=>{
    for(const id of ids){const job=vault.db.prepare('SELECT state FROM embedding_jobs WHERE recordId=?').get(id);if(!job||job.state!=='failed')throw new Error('RETRY_REQUIRES_FAILED_JOB');}
    for(const id of ids)vault.db.prepare("UPDATE embedding_jobs SET state='pending',attempts=0,error=NULL WHERE recordId=?").run(id);
    vault.event('retry_index','embedding_jobs',{ids});return {reset:ids.length};
  });
}
export async function embed(input,{timeout=3500}={}){
  const response=await fetch('http://127.0.0.1:11434/api/embed',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'bge-m3',input}),signal:AbortSignal.timeout(timeout),
  });
  if(!response.ok)throw new Error('LOCAL_EMBEDDING_UNAVAILABLE');
  const data=await response.json();
  if(!Array.isArray(data.embeddings)||data.embeddings.some(v=>!Array.isArray(v)||v.length!==1024||v.some(x=>!Number.isFinite(x))))throw new Error('INVALID_LOCAL_EMBEDDING');
  return data.embeddings;
}
function cosine(a,b){if(a.length!==b.length)return 0;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?dot/Math.sqrt(aa*bb):0;}
export async function indexPending(vault,{limit=32,embedder=embed}={}){
  const rows=vault.db.prepare("SELECT r.id,r.text,r.contentHash FROM embedding_jobs j JOIN records r ON r.id=j.recordId WHERE j.state<>'done' AND j.attempts<3 ORDER BY r.createdAt LIMIT ?").all(limit);
  let completed=0,failed=0;
  for(let i=0;i<rows.length;i+=8){const batch=rows.slice(i,i+8);
    try{
      const vectors=await embedder(batch.map(r=>r.text));
      if(vectors.length!==batch.length)throw new Error('EMBED_BATCH_MISMATCH');
      vault.db.exec('BEGIN IMMEDIATE');
      try{for(let n=0;n<batch.length;n++){
        const row=batch[n];vault.db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)').run(row.id,'bge-m3',row.contentHash,JSON.stringify(vectors[n]));
        vault.db.prepare("UPDATE embedding_jobs SET state='done',error=NULL WHERE recordId=?").run(row.id);completed++;
      }vault.db.exec('COMMIT');}catch(error){vault.db.exec('ROLLBACK');throw error;}
    }catch{
      for(const row of batch)vault.db.prepare("UPDATE embedding_jobs SET state='failed',attempts=attempts+1,error='LOCAL_EMBEDDING_UNAVAILABLE' WHERE recordId=?").run(row.id);
      failed+=batch.length;break;
    }
  }
  return {completed,failed,pending:vault.db.prepare("SELECT count(*) n FROM embedding_jobs WHERE state<>'done'").get().n};
}
export async function retrieve(vault,query,{scope='global',limit=8,semantic=true,includeArchived=false,embedder=embed}={}){
  const queryTerms=[...new Set(terms(query))].slice(0,36);
  const candidates=new Map();
  const allowed=r=>(r.scope==='global'||r.scope===scope) && (r.status==='active'||includeArchived&&r.status==='archived');
  if(queryTerms.length){
    const expression=queryTerms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
    const lexical=vault.db.prepare(`SELECT r.*,bm25(search) rank FROM search JOIN records r ON r.id=search.id WHERE search MATCH ? AND (r.scope='global' OR r.scope=?) AND (r.status='active' OR (?=1 AND r.status='archived')) ORDER BY rank LIMIT 80`).all(expression,scope,includeArchived?1:0);
    lexical.forEach((r,i)=>candidates.set(r.id,{id:r.id,score:1/(40+i+1),channels:['keyword']}));
  }
  let semanticStatus=semantic?'unavailable':'disabled';
  if(semantic){
    const vectors=vault.db.prepare("SELECT v.*,r.scope,r.status FROM vectors v JOIN records r ON r.id=v.recordId WHERE v.model='bge-m3' AND v.contentHash=r.contentHash").all().filter(allowed);
    if(vectors.length){try{
      const [vector]=await embedder([query]);
      const ranked=vectors.map(r=>({id:r.recordId,similarity:cosine(vector,JSON.parse(r.vector))})).filter(r=>r.similarity>=0.25).sort((a,b)=>b.similarity-a.similarity).slice(0,80);
      ranked.forEach((r,i)=>{const old=candidates.get(r.id)||{id:r.id,score:0,channels:[]};old.score+=1/(40+i+1);old.channels.push('semantic');candidates.set(r.id,old);});
      semanticStatus='ready';
    }catch{semanticStatus='fallback';}}else semanticStatus='not-indexed';
  }
  const hits=[...candidates.values()].map(c=>{
    const r=vault.get(c.id),trustWeight={user_confirmed:1.25,tool_observed:1.15,legacy:0.85,candidate:0.5}[r.trust];
    return {...r,retrievalScore:c.score*trustWeight,channels:c.channels};
  }).sort((a,b)=>b.retrievalScore-a.retrievalScore).slice(0,limit);
  return {hits,semanticStatus};
}
