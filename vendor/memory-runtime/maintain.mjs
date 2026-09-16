// Archival proposals are advisory; no truth/confidence changes and no deletion.
export function proposeAging(vault,{now=Date.now(),minAgeDays=180,limit=30}={}){
  if(!Number.isFinite(now)||!Number.isFinite(minAgeDays)||minAgeDays<30)throw new Error('INVALID_AGING_POLICY');
  const rows=vault.db.prepare("SELECT id,kind,createdAt,lastAccess,accessCount FROM records WHERE status='active' AND pinned=0 AND kind IN ('episode','reference')").all();
  return {dryRun:true,minAgeDays,candidates:rows.map(r=>({...r,idleDays:Math.floor((now-Date.parse(r.lastAccess||r.createdAt))/86400000)}))
    .filter(r=>r.idleDays>=minAgeDays).sort((a,b)=>b.idleDays-a.idleDays||a.accessCount-b.accessCount).slice(0,limit),
    instruction:'Review exact IDs and sources before archive. Age is not falsity. Pinned identity/preferences/decisions/lessons are excluded.'};
}
