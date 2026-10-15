import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {sentencePositions,translationVisible,createOriginalHighlight} from '../lib/native-position.mjs';
const chars=text=>[...text].map((u,i)=>({u,rect:[i*5,10,i*5+5,20]}));
const segment=(source,pages=[1])=>({source,locations:pages.map(page=>({page}))});
test('整句坐标覆盖标点；跨页、连字和断词保持准确',()=>{
  const result=sentencePositions(segment('Efficient model.'),new Map([[0,{chars:chars('Efﬁcient model. Next')}]]));
  assert.deepEqual(result,[{pageIndex:0,rects:[[0,10,75,20]]}]);
  const cross=sentencePositions(segment('Our model works.',[1,2]),new Map([[0,{chars:chars('Our mo-')}],[1,{chars:chars('del works.')}]]));
  assert.equal(cross.length,2);assert.equal(cross[1].pageIndex,1);
});
test('重复句、文字不符、缺页、错误坐标拒绝猜测',()=>{
  assert.throws(()=>sentencePositions(segment('A model.'),new Map([[0,{chars:chars('A model. A model.')}]])),/重复/);
  assert.throws(()=>sentencePositions(segment('Another.'),new Map([[0,{chars:chars('A model.')}]])),/不一致/);
  assert.throws(()=>sentencePositions(segment('A.'),new Map()),/字形/);
  assert.throws(()=>sentencePositions(segment('A'),new Map([[0,{chars:[{u:'A',rect:[NaN,1,3,4]}]}]])),/坐标/);
});
function visibleFixture() {
  const rect={left:0,top:0,right:500,bottom:500};
  const section={open:true};const details={tabID:'tab'};
  const win={innerWidth:1000,innerHeight:800,Zotero_Tabs:{selectedID:'tab'},getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',...n.style})};
  const parent={hidden:false,getAttribute:()=>null,getBoundingClientRect:()=>rect};
  const body={isConnected:true,ownerDocument:{defaultView:win},closest:s=>s==='item-details'?details:section,getBoundingClientRect:()=>rect,getAttribute:()=>null,parentElement:parent};
  return {body,parent,section,details,win};
}
test('可见门禁：折叠分区、隐藏右栏、切换标签、滚出视口均拒绝',()=>{
  const f=visibleFixture();assert.equal(translationVisible(f.body),true);
  f.section.open=false;assert.equal(translationVisible(f.body),false);f.section.open=true;
  f.parent.hidden=true;assert.equal(translationVisible(f.body),false);f.parent.hidden=false;
  f.win.Zotero_Tabs.selectedID='other';assert.equal(translationVisible(f.body),false);f.win.Zotero_Tabs.selectedID='tab';
  f.parent.style={overflowY:'auto'};f.parent.getBoundingClientRect=()=>({left:0,top:600,right:500,bottom:800});
  assert.equal(translationVisible(f.body),false);
});
test('临时覆盖层不写批注，缩放重绘，导航仅改变纵轴及销毁',async()=>{
  let layers=[],nav;const events=new Map();
  const doc={createElement:()=>({style:{},append(){},remove(){layers=layers.filter(n=>n!==this);}})};
  const page={div:{ownerDocument:doc,append:n=>layers.push(n)},viewport:{width:100,height:100,convertToViewportRectangle:r=>r}};
  const app={pdfDocument:{getPageData:async()=>({chars:chars('A model.')})},pdfViewer:{getPageView:()=>page},eventBus:{on:(e,fn)=>events.set(e,fn),off:e=>events.delete(e)}};
  const container={scrollLeft:125,clientHeight:400,scrollHeight:2000,scrollTo:options=>{nav=options;container.scrollLeft=options.left;}};
  const reader={_internalReader:{_lastView:{_iframeWindow:{PDFViewerApplication:app,document:{getElementById:()=>container}},getPositionBoundingViewRect:()=>[600,900,700,920]}}};
  const adapter=createOriginalHighlight(reader,value=>structuredClone(value));
  const positions=await adapter.locate({segments:[{id:'s00001',...segment('A model.')}]},['s00001']);
  adapter.show(positions);assert.equal(layers.length,1);assert.equal(nav,undefined);
  events.get('scalechanging')();assert.equal(layers.length,1);
  await adapter.navigate(positions);assert.deepEqual(nav,{left:125,top:695,behavior:'smooth'});assert.equal(container.scrollLeft,125);
  adapter.dispose();assert.equal(layers.length,0);assert.equal(events.size,0);
  adapter.show(positions);assert.equal(layers.length,0);
});
test('异步定位完成前关闭右栏，不高亮也不跳转',async()=>{
  let resolve,shown=0,jumped=0,disposed=0;
  const ctx=vm.createContext({Zotero:{Reader:{getByTabID:()=>({itemID:12})}}});
  vm.runInContext(await readFile(new URL('../plugin/bootstrap.js',import.meta.url),'utf8'),ctx);
  const f=visibleFixture(),view={body:f.body,status:{},highlightRevision:0};
  let visible=true;
  const instance={alive:true,views:new Map([[f.body,view]]),core:{translationVisible:()=>visible,createOriginalHighlight:()=>({locate:()=>new Promise(r=>{resolve=r;}),show:()=>shown++,navigate:()=>jumped++,dispose:()=>disposed++})}};
  const task=ctx.highlightOriginal(instance,view,{itemID:12},{pdfHash:'hash'},['s00001'],true);
  visible=false;resolve([{pageIndex:0,rects:[[0,0,10,10]]}]);await task;
  assert.equal(shown,0);assert.equal(jumped,0);assert.ok(disposed>0);
});

test('PDF worker 参数和纵向导航对象必须克隆到目标阅读器沙箱',async()=>{
  const cloned=new WeakMap(), pdfWindow={};
  const cloneInto=(value,target)=>{const copy=structuredClone(value);cloned.set(copy,target);return copy;};
  let navigated=false,painted=false;
  const page={div:{ownerDocument:{createElement:()=>({style:{},append(){},remove(){}})},append(){}},
    viewport:{width:100,height:100,convertToViewportRectangle:rect=>{
      if(cloned.get(rect)!==pdfWindow)throw new Error('Permission denied to access property 0');
      painted=true;return rect;
    }}};
  pdfWindow.PDFViewerApplication={
    pdfDocument:{getPageData:async arg=>{
      if(cloned.get(arg)!==pdfWindow) throw new Error('The object could not be cloned.');
      assert.equal(arg.pageIndex,0);return {chars:chars('A model.')};
    }},pdfViewer:{getPageView:()=>page},eventBus:{on(){},off(){}}
  };
  const container={scrollLeft:88,clientHeight:300,scrollHeight:1200,scrollTo:options=>{
    assert.equal(cloned.get(options),pdfWindow);assert.equal(options.left,88);assert.equal(options.top,545);assert.equal(options.behavior,'smooth');navigated=true;
  }};
  pdfWindow.document={getElementById:()=>container};
  const reader={_internalReader:{_lastView:{
    _iframeWindow:pdfWindow,getPositionBoundingViewRect:position=>{
      assert.equal(cloned.get(position),pdfWindow);return [350,700,400,720];
    }
  }}};
  assert.throws(()=>createOriginalHighlight(reader),/跨沙箱/);
  const source={segments:[{id:'s00001',...segment('A model.')}]};
  const broken=createOriginalHighlight(reader,value=>value);
  await assert.rejects(broken.locate(source,['s00001']),/could not be cloned/);broken.dispose();
  const adapter=createOriginalHighlight(reader,cloneInto);
  const positions=await adapter.locate(source,['s00001']);
  await adapter.navigate(positions);assert.equal(navigated,true);
  adapter.show(positions);assert.equal(painted,true);adapter.dispose();
});
