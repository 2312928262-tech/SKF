import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
function load(){const sandbox={window:{},setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(new URL('../ui-preview/event-pump.js',import.meta.url),'utf8'),sandbox);return sandbox.window.SKF_EVENT_PUMP;}
function clock(){const jobs=[];return{jobs,schedule:(fn,ms)=>{const job={fn,ms,cancelled:false};jobs.push(job);return job;},cancel:job=>{job.cancelled=true;}};}
test('HTTP/thin bridge event polling is serialized and stops without resurrecting a timer',async()=>{
 const c=clock();let release,calls=0;const stop=load().start({...c,pull:()=>{calls++;return new Promise(r=>release=r);}});
 assert.equal(c.jobs[0].ms,0);const first=c.jobs.shift().fn();assert.equal(calls,1);assert.equal(c.jobs.length,0);release();await first;assert.equal(c.jobs.length,1);assert.equal(c.jobs[0].ms,1000);
 const second=c.jobs.shift().fn();assert.equal(calls,2);stop();release();await second;assert.equal(c.jobs.length,0);
});
test('event resync backs off after errors/hidden pages; HTML and IPC use the common pump',async()=>{
 const c=clock();const stop=load().start({...c,pull:async()=>{throw Error('temporary');}});await c.jobs.shift().fn();assert.equal(c.jobs[0].ms,5000);stop();assert.equal(c.jobs[0].cancelled,true);
 const h=clock();const stopHidden=load().start({...h,pull:async()=>{},isHidden:()=>true});await h.jobs.shift().fn();assert.equal(h.jobs[0].ms,5000);stopHidden();
 const html=fs.readFileSync(new URL('../ui-preview/index.html',import.meta.url),'utf8');assert.ok(html.indexOf('event-pump.js')<html.indexOf('src="./ipc.js"'));
 const ipc=fs.readFileSync(new URL('../ui-preview/ipc.js',import.meta.url),'utf8');assert.match(ipc,/SKF_EVENT_PUMP\.start\(\{ pull: resyncSkfEvents/);assert.match(ipc,/pagehide.*, stopEventPump/);
});
