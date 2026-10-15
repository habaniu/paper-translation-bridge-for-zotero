import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ensurePaperPdf} from '../scripts/prepare-paper.mjs';

test('建档复用相同 PDF，拒绝覆盖不同版本或非 PDF',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'paper-prepare-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const first=path.join(root,'first.pdf'),second=path.join(root,'second.pdf'),invalid=path.join(root,'invalid.pdf');
  const directory=path.join(root,'paper');
  await writeFile(first,'%PDF-1.7\nfirst');
  await writeFile(second,'%PDF-1.7\nsecond');
  await writeFile(invalid,'not a PDF');
  assert.equal((await ensurePaperPdf(directory,first)).copied,true);
  assert.equal((await ensurePaperPdf(directory,first)).copied,false);
  await assert.rejects(()=>ensurePaperPdf(directory,second),/拒绝覆盖/);
  await assert.rejects(()=>ensurePaperPdf(path.join(root,'other'),invalid),/不是 PDF/);
  assert.equal(await readFile(path.join(directory,'paper.pdf'),'utf8'),'%PDF-1.7\nfirst');
});
