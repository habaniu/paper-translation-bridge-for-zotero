import {pageLines,buildSegments} from './alignment.mjs';
import {applyReviewedRegions} from './layout-review.mjs';

export const LAYOUT_VERSION='regions-v2';
const clean=t=>t.normalize('NFKC').replace(/\s/g,'');
const union=rects=>[Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))];
const text=line=>line.items.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
const heading=t=>/^(?:[IVXLCDM]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+[A-Z][A-Za-z ,:–—-]{2,100}$/.test(t)||/^(Abstract|References|Acknowledg(e)?ments|Conclusion(s)?|Appendix(?:\s+[A-Z])?)$/i.test(t);
const prose=t=>/\b(the|where|defined|constraint|policy|therefore|denotes)\b/i.test(t)||(/:\s*$/.test(t)&&!/[=≤≥∑∫]/.test(t))||(!/[=≤≥∑∫]/.test(t)&&(t.match(/\b[A-Za-z]{3,}\b/g)||[]).filter(w=>! /^(argmax|argmin|clip|min|max|log|exp|sin|cos|softmax|safe|risk|task|rec)$/i.test(w)).length>=3);

// A string can expand during NFKC (e.g. ﬁ). Keep every normalized code unit
// connected to its original offset and measured glyph box.
export function attachGlyphs(page,glyphPage) {
  const warning=glyphPage?.unsupported;
  page.items=page.items.map(item=>{
    if(!item.str?.trim())return item;
    const [a,b,c,d,x,y]=item.transform;
    if(warning||Math.abs(b)>.01||Math.abs(c)>.01||a<=0||d<=0||item.dir==='rtl')return {...item,geometryIssue:warning||'rotated or RTL text'};
    const candidates=(glyphPage?.chars||[]).filter(g=>g.upright&&Math.abs(g.baseline-y)<.8&&g.rect[0]>=x-.6&&g.rect[2]<=x+item.width+.6).sort((a,b)=>a.rect[0]-b.rect[0]);
    const measured=candidates.map(g=>clean(g.text)).join('');
    if(!measured||measured!==clean(item.str)){
      const box=candidates.length?union(candidates.map(g=>g.rect)):null;
      // Math fonts often expose different Unicode mappings in the two engines.
      // An entire text item can still use the same measured glyph extent. Never
      // divide that box proportionally to invent partial-character coordinates.
      if(box&&Math.abs(box[0]-x)<.25&&Math.abs(box[2]-(x+item.width))<.25)return {...item,wholeBox:box};
      return {...item,geometryIssue:'PDF.js 与字形抽取未能唯一对应'};
    }
    const refs=[];for(const g of candidates)for(let i=0;i<clean(g.text).length;i++)refs.push(g.rect);
    const boxes=[];let at=0,offset=0;
    for(const ch of item.str){const n=clean(ch).length;if(n){const rect=union(refs.slice(at,at+n));boxes.push({start:offset,end:offset+ch.length,rect});at+=n;}offset+=ch.length;}
    return {...item,boxes};
  });
  return page;
}

export function positionsFor(locations,pages,kind='text') {
  const grouped=new Map();
  for(const loc of locations){
    const page=pages[loc.page-1],item=page?.items[loc.item];
    if(!item||item.geometryIssue||(!item.boxes&&!item.wholeBox))throw new Error(item?.geometryIssue||'缺少字符坐标');
    if(item.wholeBox&&(loc.start!==0||loc.end!==item.str.length))throw new Error('特殊字体仅能整字形定位，局部范围需复核');
    const boxes=item.wholeBox?[{rect:item.wholeBox}]:item.boxes.filter(b=>b.start<loc.end&&b.end>loc.start);
    if(!boxes.length&&item.str.slice(loc.start,loc.end).trim())throw new Error('字符范围无坐标');
    if(!grouped.has(loc.page-1))grouped.set(loc.page-1,[]);
    for(const b of boxes) {
      const r=b.rect,view=page.view||[0,0,page.width,page.height];
      if(r[0]<view[0]-.5||r[1]<view[1]-.5||r[2]>view[2]+.5||r[3]>view[3]+.5)throw new Error('字形超出页面裁剪区域');
      if(r[2]>r[0]&&r[3]>r[1])grouped.get(loc.page-1).push([...r]);
    }
  }
  return [...grouped].filter(([,r])=>r.length).map(([pageIndex,rects])=>{
    if(kind==='equation'||kind==='heading')return {pageIndex,rects:[union(rects)]};
    // Retain line-level rectangles; do not span columns or page whitespace.
    rects.sort((a,b)=>b[1]-a[1]||a[0]-b[0]);const merged=[];
    for(const r of rects){const p=merged.at(-1);if(p&&Math.abs(p[1]-r[1])<.5&&Math.abs(p[3]-r[3])<.5&&r[0]>=p[0]&&r[0]-p[2]<3)p[2]=Math.max(p[2],r[2]);else merged.push(r);}
    return {pageIndex,rects:merged};
  });
}

export function detectRegions(pages) {
  const regions=[],issues=[];
  for(const page of pages){
    const lines=pageLines(page.items,page.width,page.page);
    const twoColumns=lines.filter(l=>l.left<page.width/2-35&&l.right<page.width/2+8&&l.right-l.left>page.width*.25).length>=4&&lines.filter(l=>l.left>page.width/2-8&&l.right-l.left>page.width*.25).length>=4;
    const used=new Set();
    const anchors=page.items.map((i,index)=>({i,index,label:i.str?.trim().match(/^\(\s*(\d+[a-z]?)\s*\)$/)?.[1]})).filter(a=>a.label);
    for(const a of anchors){
      const x=a.i.transform[4],y=a.i.transform[5],mid=page.width/2;
      // Numbered equations normally end a column. Inline citations and ordinary
      // list numbering are not equation anchors.
      if(!(x>page.width*.42&&x<mid+8||x>page.width*.82))continue;
      const left=twoColumns&&x>=mid+8?mid:0,right=twoColumns&&x<mid+8?mid:page.width;
      // Inline math often splits a prose baseline into several PDF.js lines.
      // Judge the complete row, otherwise its math fragment leaks into a display.
      const column=[];
      for(const l of lines.filter(l=>l.left>=left&&l.left<right).sort((a,b)=>b.y-a.y)){
        const row=column.find(r=>Math.abs(r.y-l.y)<3);
        if(row){row.items.push(...l.items);row.items.sort((a,b)=>a.transform[4]-b.transform[4]);row.left=Math.min(row.left,l.left);row.right=Math.max(row.right,l.right);}
        else column.push({...l,items:[...l.items]});
      }
      const eligible=l=>!heading(text(l))&&!prose(text(l))&&!/^(Fig(?:ure)?\.?|Table)\s*\d/i.test(text(l))&&!column.some(row=>row!==l&&Math.abs(row.y-l.y)<7&&prose(text(row)));
      let near=column.map((l,i)=>({l,i,d:Math.abs(l.y-y)})).filter(v=>v.d<22&&eligible(v.l)).sort((a,b)=>a.d-b.d)[0];
      if(!near){issues.push({page:page.page,items:[a.index],reason:`公式 (${a.label}) 无法确定边界`});continue;}
      let lo=near.i,hi=near.i;
      const otherAnchor=l=>anchors.some(b=>b!==a&&b.i.transform[4]>=left&&b.i.transform[4]<right&&Math.abs(b.i.transform[5]-l.y)<4);
      while(lo>0&&eligible(column[lo-1])&&!otherAnchor(column[lo-1])&&column[lo-1].y-column[lo].y<23&&Math.abs(column[lo-1].y-y)<65)lo--;
      while(hi+1<column.length&&eligible(column[hi+1])&&!otherAnchor(column[hi+1])&&column[hi].y-column[hi+1].y<23&&Math.abs(column[hi+1].y-y)<65)hi++;
      const items=column.slice(lo,hi+1).flatMap(l=>l.items).filter(i=>i.index!==a.index);
      const value=items.map(i=>i.str).join(' ');
      if(!/[=≤≥∑∫∈≈]|[A-Za-zΑ-ω]\s*\(/.test(value)||!items.length){issues.push({page:page.page,items:[a.index],reason:`编号 (${a.label}) 未能确认为完整公式`});continue;}
      const ids=[...new Set([...items.map(i=>i.index),a.index])];
      if(ids.some(i=>used.has(i))){
        const reason=`公式 (${a.label}) 与相邻公式边界重叠，需复核`;
        issues.push({page:page.page,items:ids,reason});
        for(const r of regions)if(r.page===page.page&&r.items.some(i=>ids.includes(i)))r.needsReview=reason;
        continue;
      }
      const labelled=column.slice(Math.max(0,lo-2),hi+2).some(l=>/\b(?:representation|reward|decoder|constraint|latent state|value)\s*:/i.test(text(l)));
      const dense=anchors.some(b=>b!==a&&b.i.transform[4]>=left&&b.i.transform[4]<right&&Math.abs(b.i.transform[5]-y)<45&&!column.some(l=>l.y>Math.min(y,b.i.transform[5])+3&&l.y<Math.max(y,b.i.transform[5])-3&&/\b(the|where|and|is|are|for)\b/i.test(text(l))&&prose(text(l))));
      const needsReview=dense?'密集相邻编号公式边界需人工复核':labelled?'带文字标签的多行公式边界需人工复核':undefined;
      if(needsReview)issues.push({page:page.page,reason:needsReview,label:a.label});
      ids.forEach(i=>used.add(i));regions.push({kind:'equation',label:a.label,page:page.page,items:ids,needsReview});
    }
    for(const l of lines){
      const t=text(l),ids=l.items.map(i=>i.index);
      if(ids.some(i=>used.has(i)))continue;
      if(heading(t)){ids.forEach(i=>used.add(i));regions.push({kind:'heading',page:page.page,items:ids});}
      else if(!prose(t)&&/[=≤≥∑∫]/.test(t)){
        const column=l.left<page.width/2?0:1;
        const bodyLines=lines.filter(x=>(x.left<page.width/2?0:1)===column&&prose(text(x)));
        const margin=bodyLines.length?Math.min(...bodyLines.map(x=>x.left)):Infinity;
        const solitary=!lines.some(x=>x!==l&&Math.abs(x.y-l.y)<3&&(x.left<page.width/2?0:1)===column&&prose(text(x)));
        if(solitary&&l.left>margin+12&&t.length<130&&!/\b(where|the|and|is|for|denotes|defined)\b/i.test(t)){
          // A baseline alone cannot establish an unnumbered display's full
          // extent (superscripts, braces and wide gaps may be separate lines).
          const reason='未编号数学区域边界需人工复核';
          ids.forEach(i=>used.add(i));regions.push({kind:'equation',page:page.page,items:ids,needsReview:reason});
          issues.push({page:page.page,reason,items:ids});
        }else issues.push({page:page.page,reason:'未编号或边界不确定的数学区域需核对',items:ids});
      }
    }
  }
  return {regions,issues};
}

export function buildLayout(pages,{overrides,pdfHash}={}) {
  const {regions,issues}=applyReviewedRegions(pages,detectRegions(pages),overrides,pdfHash);
  const units=buildSegments(pages,{regions});
  // Display equations can be emitted at a superscript before the baseline. Keep
  // reading order from the original spatial traversal, not numeric labels.
  const segments=units.map((s,i)=>{
    const result={...s,id:`s${String(i+1).padStart(5,'0')}`};
    const uncertain=issues.find(issue=>/^(公式|编号)/.test(issue.reason)&&issue.items&&s.locations.some(l=>l.page===issue.page&&issue.items.includes(l.item)));
    try{if(s.needsReview||uncertain)throw new Error(s.needsReview||uncertain.reason);result.positions=positionsFor(s.locations,pages,s.kind);if(!result.positions.length)throw new Error('空定位区域');}
    catch(e){
      result.needsReview=e.message;issues.push({id:result.id,page:s.locations[0]?.page,reason:e.message});
      // Diagnostic boxes only. Runtime matching never uses these candidates.
      const preview=new Map();
      for(const loc of s.locations){const item=pages[loc.page-1].items[loc.item],x=item.transform[4],y=item.transform[5],h=Math.abs(item.height||item.transform[3]);
        const rect=item.wholeBox||(item.boxes?.length?union(item.boxes.map(b=>b.rect)):[x,y-h*.2,x+item.width,y+h*.8]);
        if(rect.every(Number.isFinite)&&rect[2]>rect[0]&&rect[3]>rect[1]){if(!preview.has(loc.page-1))preview.set(loc.page-1,[]);preview.get(loc.page-1).push(rect);}}
      result.reviewPositions=[...preview].map(([pageIndex,rects])=>({pageIndex,rects:s.kind==='text'?rects:[union(rects)]}));
    }
    return result;
  });
  return {segments,issues,regions};
}
