import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {attachGlyphs,positionsFor,buildLayout} from '../lib/layout.mjs';
import {snapshotLayout,applyDraft,planMigration,upgradeGeometry} from '../lib/layout-store.mjs';
import {matchRegions,translationPieces} from '../lib/native-regions.mjs';
import {EXTRACTOR_VERSION,buildSegments} from '../lib/alignment.mjs';
import {applyReviewedRegions} from '../lib/layout-review.mjs';
import {prepareSource,hash} from '../lib/store.mjs';
const item=(str,x,y,width=100)=>({str,transform:[10,0,0,10,x,y],width,height:10,dir:'ltr',wholeBox:[x,y-2,x+width,y+8]});
test('先分区域再切句：标题和公式不影响前后正文标点与范围',()=>{
  const p={page:1,width:600,height:800,items:[item('We impose',50,740),item('x = y, s.t. x > 0',100,720,220),item('(1)',550,720,15),item('where x is positive. A second sentence.',50,700,350)]};
  const result=buildSegments([p],{regions:[{page:1,kind:'equation',label:'1',items:[1,2]}]});
  assert.deepEqual(result.map(s=>s.source),['We impose','x = y, s.t. x > 0 (1)','where x is positive.','A second sentence.']);
  assert.deepEqual(result[1].locations.map(l=>l.item),[1,2]);
  const refs=result.flatMap(s=>s.locations.flatMap(l=>Array.from({length:l.end-l.start},(_,i)=>`${l.item}:${l.start+i}`)));
  assert.equal(refs.length,new Set(refs).size);
});
test('复核区域按 PDF 和提取器绑定，拒绝重叠或不完整替换，候选框不参与匹配',()=>{
  const pages=[{page:1,width:600,height:800,items:[item('x = y',100,680),item('(1)',550,680,15),item('z = a',100,660),item('(2)',550,660,15)]}];
  const overrides={version:1,pdfHash:'hash',itemExtractor:EXTRACTOR_VERSION,regions:[{key:'one',page:1,kind:'equation',label:'1',items:[0,1],reviewed:true,note:'verified'},{key:'two',page:1,kind:'equation',label:'2',items:[2,3],reviewed:true,note:'verified'}]};
  const layout=buildLayout(pages,{overrides,pdfHash:'hash'});
  assert.equal(layout.segments.filter(s=>s.kind==='equation'&&s.positions&&!s.needsReview).length,2);
  assert.throws(()=>buildLayout(pages,{overrides,pdfHash:'other'}),/版本不一致/);
  const duplicate=structuredClone(overrides);duplicate.regions[1].items.push(0);
  assert.throws(()=>buildLayout(pages,{overrides:duplicate,pdfHash:'hash'}),/无效或重复/);
  assert.throws(()=>applyReviewedRegions(pages,{regions:[{page:1,kind:'equation',items:[0,1,2]}],issues:[]},{...overrides,regions:overrides.regions.slice(0,1)},'hash'),/全部文本项/);
  const source={version:2,pageSizes:[{width:600,height:800}],segments:[{id:'s00001',reviewPositions:[{pageIndex:0,rects:[[10,10,20,20]]}]}]};
  assert.equal(matchRegions(source,{position:{pageIndex:0,rects:[[10,10,20,20]]}}),null);
});
test('字形按实测宽度映射，兼容连字，特殊编码只允许整项坐标',()=>{
  const p={items:[item('Wiﬁ',10,50,14)],width:600,height:800};
  attachGlyphs(p,{chars:[{text:'W',rect:[10,48,20,58],baseline:50,upright:true},{text:'i',rect:[20,48,21,58],baseline:50,upright:true},{text:'ﬁ',rect:[21,48,24,58],baseline:50,upright:true}]});
  delete p.items[0].wholeBox;
  assert.deepEqual(positionsFor([{page:1,item:0,start:1,end:2}],[p])[0].rects,[[20,48,21,58]]);
  assert.deepEqual(positionsFor([{page:1,item:0,start:2,end:3}],[p])[0].rects,[[21,48,24,58]]);
  const q={items:[item('XX',10,50,14)],width:600,height:800};
  attachGlyphs(q,{chars:[{text:'∑',rect:[10,48,24,58],baseline:50,upright:true}]});
  assert.deepEqual(positionsFor([{page:1,item:0,start:0,end:2}],[q])[0].rects,[[10,48,24,58]]);
  assert.throws(()=>positionsFor([{page:1,item:0,start:0,end:1}],[q]),/局部/);
  attachGlyphs(q,{unsupported:'rotated page'});
  assert.throws(()=>positionsFor([{page:1,item:0,start:0,end:2}],[q]),/rotated/);
});
test('单栏公式独立于短引导语，Roman 标题完整，公式内部 s.t. 不切句',()=>{
  const p={page:1,width:600,height:800,items:[item('IV. Method',50,750),item('be defined as:',50,700),item('x = y, s.t. x > 0',100,680,220),item('(1)',550,680,15),item('where the variable is positive.',50,658,250),item('t',290,663,3)]};
  const layout=buildLayout([p]);
  const eq=layout.segments.find(s=>s.kind==='equation');
  assert.equal(eq.label,'1');assert.deepEqual(eq.locations.map(l=>l.item),[2,3]);
  assert.deepEqual(eq.positions[0].rects,[[100,678,565,688]]);
  assert.equal(layout.segments.find(s=>s.kind==='heading').source,'IV. Method');
  assert.ok(!eq.source.includes('defined'));
});
test('未编号及密集公式不以部分区域冒充可靠定位',()=>{
  const p={page:1,width:600,height:800,items:[item('The following equations are given.',50,730,400),item('x = y',100,680),item('(1)',550,680,15),item('z = a',100,655),item('(2)',550,655,15),item('a = b',100,570)]};
  const layout=buildLayout([p]);
  assert.ok(layout.segments.filter(s=>s.kind==='equation').every(s=>s.needsReview&&!s.positions));
});
test('独立公式目标双向关联；跨公式和正文选区不会丢正文',()=>{
  const pos=rect=>[{pageIndex:0,rects:[rect]}];
  const s={version:2,pageSizes:[{width:600,height:800}],segments:[{id:'s00001',positions:pos([50,100,300,180])},{id:'s00002',positions:pos([50,190,300,200])}],targets:[{id:'eq-1-1',label:'1',ids:['s00001'],positions:pos([50,100,300,120])}]};
  const sel=rects=>({position:{pageIndex:0,rects}});
  assert.deepEqual(matchRegions(s,sel([[80,102,90,112]])).targets,['eq-1-1']);
  const mixed=matchRegions(s,sel([[80,102,90,112],[80,192,90,199]]));
  assert.equal(mixed.targets,undefined);assert.deepEqual(mixed.ids,['s00001','s00002']);
  const pieces=translationPieces([{ids:['s00001'],markdown:'正文\n$$x=y\\tag{1}$$\n解释'}],s);
  assert.equal(pieces.length,3);assert.equal(pieces[1].target,'eq-1-1');assert.equal(pieces[0].target,undefined);
});
test('迁移拒绝异 PDF 和歧义正文；保留编号升级不重编号',()=>{
  const locations=[{page:1,item:0,start:0,end:3}];
  const old={pdfHash:'a',segments:[{id:'s00420',kind:'text',locations}]};
  const next={pdfHash:'a',pageSizes:[{width:600,height:800}],layoutIssues:[],segments:[{id:'s00001',kind:'equation',label:'1',locations,positions:[{pageIndex:0,rects:[[1,1,2,2]]}]}]};
  assert.throws(()=>planMigration(old,{...next,pdfHash:'b'},{fragments:[]}),/校验值/);
  assert.equal(planMigration(old,next,{fragments:[{ids:['s00420'],markdown:'正文而非带标签公式'}]}).blocked.length,1);
  const upgraded=upgradeGeometry(old,next,[{width:600,height:800,items:[item('x=y',10,50)]}]);
  assert.equal(upgraded.segments[0].id,'s00420');assert.deepEqual(upgraded.targets[0].ids,['s00420']);
});
test('迁移备份、锁与用户编辑保护；保留模式完全不写 Markdown',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layout-test-'));
  try{
    await mkdir(path.join(dir,'.translation'));await writeFile(path.join(dir,'paper.pdf'),'fixture');
    const source={pdfHash:createHash('sha256').update('fixture').digest('hex'),segments:[]};
    await writeFile(path.join(dir,'translated.md'),'original');
    const expected=await snapshotLayout(dir);
    await writeFile(path.join(dir,'translated.md'),'user edit');
    await assert.rejects(()=>applyDraft(dir,source,'replacement',expected),/已修改/);
    assert.equal(await readFile(path.join(dir,'translated.md'),'utf8'),'user edit');
    await assert.rejects(()=>access(path.join(dir,'.translation/layout-migration.lock')));
    const fresh=await snapshotLayout(dir),backup=await applyDraft(dir,source,undefined,fresh);
    assert.equal(await readFile(path.join(backup,'translated.md'),'utf8'),'user edit');
    assert.equal(await readFile(path.join(dir,'translated.md'),'utf8'),'user edit');
    await writeFile(path.join(dir,'.translation/layout-migration.lock'),'busy');
    await assert.rejects(()=>applyDraft(dir,source,undefined,fresh),/EEXIST/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('复核记录变化不能静默重建已有译文索引；迁移快照包含复核记录',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layout-overrides-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'.translation'));
  await writeFile(path.join(dir,'paper.pdf'),'fixture');
  const record=JSON.stringify({version:1,pdfHash:hash('fixture'),itemExtractor:EXTRACTOR_VERSION,regions:[]});
  await writeFile(path.join(dir,'.translation/layout-overrides.json'),record);
  const source={extractor:'regions-v2',pdfHash:hash('fixture'),reviewOverridesHash:hash(record),segments:[]};
  const raw=JSON.stringify(source);
  await writeFile(path.join(dir,'.translation/source.json'),raw);
  await writeFile(path.join(dir,'translated.md'),'user translation');
  assert.deepEqual(await prepareSource(dir),source);
  const expected=await snapshotLayout(dir);
  await writeFile(path.join(dir,'.translation/layout-overrides.json'),record+'\n');
  await assert.rejects(()=>prepareSource(dir),/复核记录已更新/);
  await assert.rejects(()=>applyDraft(dir,source,undefined,expected),/已修改/);
  assert.equal(await readFile(path.join(dir,'.translation/source.json'),'utf8'),raw);
  assert.equal(await readFile(path.join(dir,'translated.md'),'utf8'),'user translation');
  const backup=await applyDraft(dir,source,undefined,await snapshotLayout(dir));
  assert.equal(await readFile(path.join(backup,'layout-overrides.json'),'utf8'),record+'\n');
});
