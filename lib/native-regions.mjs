// PDF user-space geometry, tied to the source PDF hash. No PDF.js item index
// is ever passed to Zotero. Reject invalid or out-of-page coordinates.
export function regionPositions(source, segment) {
  if (!segment.positions) return null;
  if (!Array.isArray(segment.positions) || !segment.positions.length) throw new Error('定位区域为空');
  return segment.positions.map(({pageIndex,rects})=>{
    const size=source.pageSizes?.[pageIndex];
    if (!Number.isInteger(pageIndex) || !size || !Array.isArray(rects) || !rects.length) throw new Error('定位区域页码无效');
    const view=size.view||[0,0,size.width,size.height];
    const copy=rects.map(r=>{
      if (!Array.isArray(r) || r.length!==4 || !r.every(Number.isFinite) || r[0]<view[0]-.5 || r[1]<view[1]-.5 || r[2]<=r[0] || r[3]<=r[1] || r[2]>view[2]+.5 || r[3]>view[3]+.5) throw new Error('定位区域坐标无效');
      return [...r];
    });
    return {pageIndex,rects:copy};
  });
}

export function matchRegions(source, selection) {
  const p=selection?.position;
  if (!Number.isInteger(p?.pageIndex)) return null;
  const selected=[{pageIndex:p.pageIndex,rects:p.rects||[]},{pageIndex:p.pageIndex+1,rects:p.nextPageRects||[]}];
  const hit=[],targetHits=[];
  for(const segment of [...(source.targets||[]),...source.segments]) {
    const positions=regionPositions(source,segment);
    if(!positions)continue;
    if(selected.some(page=>positions.some(region=>region.pageIndex===page.pageIndex && page.rects.some(a=>{
      if(!Array.isArray(a)||a.length!==4||!a.every(Number.isFinite))return false;
      const area=(a[2]-a[0])*(a[3]-a[1]);if(area<=0)return false;
      return region.rects.some(b=>{
        const overlap=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
        return overlap/Math.min(area,(b[2]-b[0])*(b[3]-b[1]))>.3;
      });
    })))){if(segment.ids)targetHits.push(segment);else hit.push(segment.id);}
  }
  if(targetHits.length){
    // A mixed formula/body selection must not discard the body. Only prefer
    // a formula target when every selection rectangle is inside a target.
    const formulaOnly=selected.every(p=>p.rects.every(a=>targetHits.some(t=>t.positions.some(r=>r.pageIndex===p.pageIndex&&r.rects.some(b=>a[0]>=b[0]-2&&a[1]>=b[1]-2&&a[2]<=b[2]+2&&a[3]<=b[3]+2)))));
    return {ids:[...new Set([...hit,...targetHits.flatMap(t=>t.ids)])],...(formulaOnly?{targets:targetHits.map(t=>t.id)}:{})};
  }
  return hit.length?{ids:hit}:null;
}

// Legacy IDs stay unchanged. Only explicitly tagged display equations get a
// separate UI target; no Chinese sentence splitting or model inference here.
export function translationPieces(fragments,source){
  if(!source.targets?.length)return fragments;
  return fragments.flatMap(f=>{
    const pieces=f.markdown.split(/(\$\$[\s\S]*?\$\$)/g).filter(p=>p.trim());
    return pieces.map(markdown=>{
      const labels=[...markdown.matchAll(/\\tag\{([^}]+)\}/g)].map(m=>m[1]);
      const candidates=markdown.trim().startsWith('$$')&&labels.length===1?source.targets.filter(t=>t.label===labels[0]&&t.ids.some(id=>f.ids.includes(id))):[];
      return {...f,markdown,target:candidates.length===1?candidates[0].id:undefined};
    });
  });
}
