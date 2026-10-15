import test from 'node:test';
import assert from 'node:assert/strict';
import { sentenceRanges, buildSegments, parseTranslation, matchingIds, pageLines } from '../lib/alignment.mjs';
const item = (str,x=40,y=500,width=str.length*5) => ({str,transform:[10,0,0,10,x,y],width,height:10});
const page = (items,number=1) => ({page:number,width:600,height:800,items});

test('学术缩写、数字与引号不会造成错误拆句',() => {
  const text = 'As shown in Fig. 2, we use 3.14 units (e.g. frames). Does it work? Yes!';
  assert.deepEqual(sentenceRanges(text).map(r=>text.slice(r.start,r.end)),[
    'As shown in Fig. 2, we use 3.14 units (e.g. frames).','Does it work?','Yes!']);
});
test('同一文本项内选择半句和跨句按字符范围匹配',() => {
  const segments = buildSegments([page([item('First sentence. Second sentence.')])]);
  assert.deepEqual(matchingIds(segments,[{page:1,item:0,start:3,end:7}]),['s00001']);
  assert.deepEqual(matchingIds(segments,[{page:1,item:0,start:8,end:22}]),['s00001','s00002']);
  assert.deepEqual(matchingIds(segments,[{page:1,item:0,start:16,end:18}]),['s00002']);
});
test('重复英文通过页码和文本项区分',() => {
  const segments = buildSegments([page([item('Same sentence.')]),page([item('Same sentence.')],2)]);
  assert.deepEqual(matchingIds(segments,[{page:2,item:0,start:0,end:4}]),['s00002']);
});
test('跨页句子保留两页位置，断词修复不影响原始字符偏移',() => {
  const segments = buildSegments([page([item('We use recur-',40,55)]),page([item('rent memory to act.',40,740)],2)]);
  assert.equal(segments.length,1); assert.equal(segments[0].source,'We use recurrent memory to act.');
  assert.deepEqual(matchingIds(segments,[{page:2,item:0,start:0,end:4}]),['s00001']);
});
test('窄栏间距仍按完整左栏再右栏排序',() => {
  const items=[];
  for(let i=0;i<8;i++) { items.push(item(`Left ${i}.`,40,700-i*14,251)); items.push(item(`Right ${i}.`,310,700-i*14,250)); }
  const lines=pageLines(items,600,1);
  assert.equal(lines.length,16);
  assert.deepEqual(lines.slice(0,8).map(l=>l.items[0].str),Array.from({length:8},(_,i)=>`Left ${i}.`));
});
const source = {pdfHash:'a'.repeat(64),segments:[{id:'s00001'},{id:'s00002'}]};
const header = `<!-- source-sha256: ${source.pdfHash} -->\n`;
test('合译块支持多个编号，并保留译文切片范围',() => {
  const md=header+'<!-- s00001 s00002 -->\n## 方法\n我们使用记忆。';
  const result=parseTranslation(md,source);
  assert.equal(result.translated,2); assert.deepEqual(result.errors,[]); assert.deepEqual(result.missing,[]);
  assert.equal(md.slice(result.fragments[0].start,result.fragments[0].end).trim(),result.fragments[0].markdown);
});
test('缺失、空译文、重复、未知编号和原 PDF 变化均被发现',() => {
  const result=parseTranslation(header+'<!-- s00001 -->\n译文。\n<!-- s00001 -->\n重复。\n<!-- s99999 -->',source);
  assert.deepEqual(result.missing,['s00002']);
  assert.ok(result.errors.some(e=>e.includes('重复'))); assert.ok(result.errors.some(e=>e.includes('未知'))); assert.ok(result.errors.some(e=>e.includes('为空')));
  assert.ok(parseTranslation(header.replaceAll('a','b')+'<!-- s00001 -->译文',source).errors.length);
  assert.equal(parseTranslation('<!-- s00001 -->译文',source).bindingValid,false);
});
test('没有译文时不会伪造匹配或完成状态',() => {
  const result=parseTranslation('',source); assert.equal(result.translated,0); assert.equal(result.bindingValid,false); assert.equal(result.missing.length,2);
});
