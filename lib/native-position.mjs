import { regionPositions } from './native-regions.mjs';
const positionText = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Match source sentences against Zotero's own character geometry. Never reuse
// offline PDF.js item indexes in Zotero, and never guess between repeated text.
export function sentencePositions(segment, pages) {
  const chars = [];
  for (const pageIndex of [...new Set(segment.locations.map(l => l.page - 1))].sort((a,b)=>a-b)) {
    const data = pages.get(pageIndex);
    if (!data?.chars) throw new Error('当前 Zotero 无法提供原文字形位置');
    for (const char of data.chars) chars.push({ ...char, pageIndex });
  }
  let text = ''; const refs = [];
  chars.forEach((char, index) => {
    const value = positionText(char.u || ''); text += value;
    for (let i=0;i<value.length;i++) refs.push(index);
  });
  const query = positionText(segment.source);
  const start = query ? text.indexOf(query) : -1;
  if (start < 0) throw new Error('原句与 Zotero 文本不一致，无法可靠高亮');
  if (text.indexOf(query, start + 1) !== -1) throw new Error('原句在页面中重复，无法唯一定位');
  const first = refs[start]; let last = refs[start + query.length - 1];
  while (last + 1 < chars.length && chars[last+1].pageIndex === chars[last].pageIndex && /^[.,;:!?，。；：！？)\]”’]+$/.test(chars[last+1].u || '')) last++;
  const groups = new Map();
  for (const char of chars.slice(first,last+1)) {
    const r = char.rect;
    if (!r || r.length !== 4 || !r.every(Number.isFinite)) throw new Error('原句字形坐标无效');
    if (r[2] <= r[0] || r[3] <= r[1]) continue;
    if (!groups.has(char.pageIndex)) groups.set(char.pageIndex, []);
    const rects = groups.get(char.pageIndex), previous = rects.at(-1);
    if (previous && Math.abs(previous[1]-r[1])<.5 && Math.abs(previous[3]-r[3])<.5 && r[0]>=previous[0] && r[0]-previous[2]<3) previous[2]=Math.max(previous[2],r[2]);
    else rects.push([...r]);
  }
  if (![...groups.values()].some(r=>r.length)) throw new Error('原句没有可显示的位置');
  return [...groups].map(([pageIndex,rects])=>({pageIndex,rects}));
}

export function translationVisible(body) {
  if (!body?.isConnected) return false;
  const win=body.ownerDocument.defaultView;
  const details=body.closest('item-details');
  if (details?.tabID && details.tabID !== win.Zotero_Tabs?.selectedID) return false;
  const section=body.closest('collapsible-section');
  if (section && !section.open) return false;
  let box=body.getBoundingClientRect();
  let left=Math.max(0,box.left),top=Math.max(0,box.top),right=Math.min(win.innerWidth,box.right),bottom=Math.min(win.innerHeight,box.bottom);
  for (let node=body;node;node=node.parentElement) {
    const style=win.getComputedStyle(node);
    if (node.hidden || node.getAttribute('collapsed')==='true' || style.display==='none' || style.visibility==='hidden' || style.opacity==='0') return false;
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX+' '+style.overflowY)) {
      box=node.getBoundingClientRect(); left=Math.max(left,box.left);right=Math.min(right,box.right);top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);
    }
  }
  return right-left>1 && bottom-top>1;
}

export function createOriginalHighlight(reader, cloneInto) {
  // Adapter isolated to Zotero 10 internals; fail closed on incompatible APIs.
  const view=reader._internalReader?._lastView || reader._internalReader?._primaryView;
  const app=view?._iframeWindow?.PDFViewerApplication;
  if (!app?.pdfDocument?.getPageData || !app.pdfViewer || !app.eventBus || !view.getPositionBoundingViewRect) throw new Error('当前 Zotero 阅读器不支持整句定位接口');
  if (typeof cloneInto !== 'function') throw new Error('缺少 Zotero 跨沙箱数据转换接口');
  const nodes=[]; let positions=[]; let disposed=false;
  const clear=()=>{for(const node of nodes) node.remove();nodes.length=0;};
  const draw=()=>{
    clear(); if(disposed) return;
    for(const position of positions) {
      const page=app.pdfViewer.getPageView(position.pageIndex);
      if(!page?.div || !page.viewport) continue;
      const layer=page.div.ownerDocument.createElement('div');
      layer.className='paper-translator-temporary-highlight';
      layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;';
      for(const rect of position.rects) {
        const [x1,y1,x2,y2]=page.viewport.convertToViewportRectangle(cloneInto(rect,view._iframeWindow));
        const node=page.div.ownerDocument.createElement('div');
        node.style.cssText=`position:absolute;pointer-events:none;background:rgba(255,185,30,.32);left:${Math.min(x1,x2)/page.viewport.width*100}%;top:${Math.min(y1,y2)/page.viewport.height*100}%;width:${Math.abs(x2-x1)/page.viewport.width*100}%;height:${Math.abs(y2-y1)/page.viewport.height*100}%;`;
        layer.append(node);
      }
      page.div.append(layer); nodes.push(layer);
    }
  };
  const events=['pagerendered','scalechanging','rotationchanging'];
  for(const name of events) app.eventBus.on(name,draw);
  return {
    async locate(source,ids) {
      const segments=ids.map(id=>source.segments.find(s=>s.id===id)||source.targets?.find(s=>s.id===id));
      if(segments.some(s=>!s)) throw new Error('译文句子编号无效');
      const pages=new Map();
      // PDF.js forwards this object unchanged to worker.postMessage. A chrome
      // compartment wrapper is not structured-cloneable inside that worker.
      const geometry=new Map(segments.map(s=>[s.id,regionPositions(source,s)]));
      if((source.version>=2||source.geometryVersion)&&segments.some(s=>!geometry.get(s.id)))throw new Error('该区域需要版面复核，拒绝使用文字猜测位置');
      for(const index of new Set(segments.filter(s=>!geometry.get(s.id)).flatMap(s=>s.locations.map(l=>l.page-1)))) pages.set(index,await app.pdfDocument.getPageData(cloneInto({pageIndex:index},view._iframeWindow)));
      return segments.flatMap(segment=>geometry.get(segment.id)||sentencePositions(segment,pages));
    },
    show(next) {if(disposed)return;positions=next;draw();},
    async navigate(next) {
      if(disposed || !next.length)return;
      // Zotero's navigateToPosition centers the horizontal axis as well.
      const target=view._iframeWindow;
      const container=target.document.getElementById('viewerContainer');
      if(!container)throw new Error('找不到 Zotero PDF 滚动容器');
      const rect=view.getPositionBoundingViewRect(cloneInto(next[0],target));
      if(!Number.isFinite(rect?.[1]))throw new Error('原文纵向位置无效');
      const top=Math.max(0,Math.min(rect[1]-container.clientHeight/2-5,container.scrollHeight-container.clientHeight));
      container.scrollTo(cloneInto({left:container.scrollLeft,top,behavior:'smooth'},target));
    },
    dispose() {disposed=true;clear();for(const name of events)app.eventBus.off(name,draw);}
  };
}
