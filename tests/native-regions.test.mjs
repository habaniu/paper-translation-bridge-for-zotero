import test from 'node:test';
import assert from 'node:assert/strict';
import {regionPositions} from '../lib/native-regions.mjs';
import {mapNativeSelection} from '../lib/native-mapping.mjs';
import {createOriginalHighlight} from '../lib/native-position.mjs';
const s={id:'s00001',source:'formula',locations:[{page:4}],positions:[{pageIndex:3,rects:[[50,600,300,660]]}]};
const source={pageSizes:Array(4).fill({width:612,height:792}),segments:[s]};
test('公式符号和短标题按实际区域匹配，而不是文字顺序',()=>{
  assert.deepEqual(mapNativeSelection(source,{text:'≤',position:{pageIndex:3,rects:[[80,620,90,630]]}}).ids,['s00001']);
  assert.deepEqual(mapNativeSelection(source,{text:'≤',position:{pageIndex:2,rects:[[80,620,90,630]]}}).ids,[]);
  assert.deepEqual(mapNativeSelection(source,{text:'≤',position:{pageIndex:3,rects:[[400,620,410,630]]}}).ids,[]);
  assert.throws(()=>regionPositions(source,{positions:[{pageIndex:5,rects:[[1,2,3,4]]}]}),/页码/);
  assert.throws(()=>regionPositions(source,{positions:[{pageIndex:3,rects:[[1,2,900,4]]}]}),/坐标/);
});
test('公式区域反向定位绕过整句文本搜索，直接跳至公式页',async()=>{
  let dest;
  const app={pdfDocument:{getPageData:()=>{throw new Error('Must not search text');}},pdfViewer:{},eventBus:{on(){},off(){}}};
  const r={_internalReader:{_lastView:{_iframeWindow:{PDFViewerApplication:app,document:{getElementById:()=>({scrollLeft:0,clientHeight:100,scrollHeight:1000,scrollTo:p=>{dest=p;}})}},getPositionBoundingViewRect:()=>[0,200,10,210]}}};
  const adapter=createOriginalHighlight(r,v=>structuredClone(v));
  const p=await adapter.locate(source,['s00001']);
  assert.equal(p[0].pageIndex,3);assert.deepEqual(p[0].rects,[[50,600,300,660]]);
  await adapter.navigate(p);
  assert.equal(dest.left,0);assert.equal(dest.top,145);adapter.dispose();
});
