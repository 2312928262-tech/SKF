import { mkdirSync,writeFileSync,renameSync } from 'node:fs';
import { resolve,join } from 'node:path';
function atomicText(path,text){mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path+'.tmp',text,{encoding:'utf8',flush:true});renameSync(path+'.tmp',path);}
export function project(vault,workspace){
  const target=resolve(workspace,'memory','active');
  vault.db.exec('BEGIN IMMEDIATE');
  try{
    const head=vault.db.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').get()?.seq||0;
    const records=vault.db.prepare("SELECT * FROM records WHERE status='active' AND trust IN ('user_confirmed','tool_observed') ORDER BY pinned DESC,kind,id").all();
    const tasks=vault.db.prepare("SELECT * FROM tasks WHERE state IN ('pending','running','blocked') ORDER BY updatedAt DESC").all();
    const lessons=vault.db.prepare("SELECT * FROM records WHERE kind='lesson' AND status='active' ORDER BY updatedAt DESC LIMIT 40").all();
    const heading=`> SKF统一记忆 v2 的只读投影。主档：${vault.root}。事件序号：${head}。勿在投影里手改事实；用 memory-v2.mjs 更正主档。\n\n`;
    const format=r=>`## ${r.kind} · ${r.id}\n\n${r.text}\n\n来源：${JSON.parse(r.source).map(s=>s.locator).join('；')}\n`;
    atomicText(join(target,'confirmed.md'),'# 已确认记忆\n\n'+heading+records.map(format).join('\n'));
    atomicText(join(target,'tasks.md'),'# 当前任务\n\n'+heading+tasks.map(t=>`## ${t.title}\n\n状态：${t.state}；下一步：${t.nextAction}\n\n任务 ID：${t.id}\n`).join('\n'));
    atomicText(join(target,'lessons.md'),'# 历史经验（带来源，按场景使用）\n\n'+heading+lessons.map(format).join('\n'));
    atomicText(join(target,'manifest.json'),JSON.stringify({schemaVersion:2,eventSequence:head,records:records.length,tasks:tasks.length,lessons:lessons.length},null,2));
    vault.db.exec('COMMIT');return {eventSequence:head,records:records.length,tasks:tasks.length,lessons:lessons.length};
  }catch(error){vault.db.exec('ROLLBACK');throw error;}
}
