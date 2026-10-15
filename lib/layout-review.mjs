import {EXTRACTOR_VERSION} from './alignment.mjs';

// Reviewed boundaries name source text items, never invented character boxes.
// A PDF hash and extractor version prevent reusing a review on another input.
export function applyReviewedRegions(pages, detected, overrides, pdfHash) {
  if (!overrides) return detected;
  if (overrides.version!==1 || overrides.pdfHash!==pdfHash || overrides.itemExtractor!==EXTRACTOR_VERSION)
    throw new Error('版面复核记录的 PDF 或文本提取版本不一致');
  if (!Array.isArray(overrides.regions)) throw new Error('版面复核记录缺少 regions');
  const claimed=new Set(),keys=new Set(),labels=new Set();
  const reviewed=overrides.regions.map(r=>{
    if (!r.key || keys.has(r.key) || r.reviewed!==true || !r.note?.trim() || !['equation','heading'].includes(r.kind))
      throw new Error('复核区域必须有唯一 key、类型、reviewed=true 和核对说明');
    keys.add(r.key);
    const page=pages[r.page-1];
    if (!Number.isInteger(r.page)||!page||!Array.isArray(r.items)||!r.items.length) throw new Error('复核区域页码或文本项为空');
    for (const i of r.items) {
      const key=`${r.page}:${i}`;
      if (!Number.isInteger(i)||!page.items[i]?.str?.trim()||claimed.has(key)) throw new Error(`复核区域文本项无效或重复：${key}`);
      claimed.add(key);
    }
    if(r.label) labels.add(`${r.page}:${r.label}`);
    return {page:r.page,kind:r.kind,label:r.label,items:[...r.items],reviewed:{key:r.key,note:r.note}};
  });
  const regions=detected.regions.filter(r=>{
    const covered=r.items.filter(i=>claimed.has(`${r.page}:${i}`));
    if (!covered.length) return true;
    if (covered.length!==r.items.length) throw new Error(`复核方案未覆盖被替换区域的全部文本项：第 ${r.page} 页 ${r.label||r.kind}`);
    return false;
  });
  const issues=detected.issues.filter(i=>!(i.items?.length&&i.items.every(n=>claimed.has(`${i.page}:${n}`)))&&!(i.label&&labels.has(`${i.page}:${i.label}`)));
  return {regions:[...regions,...reviewed],issues};
}
