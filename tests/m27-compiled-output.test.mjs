import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {orphanCompiledOutputs,assertCurrentCompiledOutput} from '../scripts/lib/compiled-output.mjs';

test('packaging refuses leftover JavaScript for deleted source files without silently deleting anything',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skf-m27-package-'));
  try{
    fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.mkdirSync(path.join(root,'dist','tools'),{recursive:true});
    fs.writeFileSync(path.join(root,'src','active.ts'),'export const ok=true;');
    fs.writeFileSync(path.join(root,'dist','active.js'),'export const ok=true;');
    const stale=path.join(root,'dist','tools','retired.js');fs.writeFileSync(stale,'export const retired=true;');
    assert.deepEqual(orphanCompiledOutputs(root),['tools/retired.js']);
    assert.throws(()=>assertCurrentCompiledOutput(root),/STALE_COMPILED_OUTPUT/);
    assert.ok(fs.existsSync(stale),'the gate must be read-only');
    fs.unlinkSync(stale);assert.doesNotThrow(()=>assertCurrentCompiledOutput(root));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
