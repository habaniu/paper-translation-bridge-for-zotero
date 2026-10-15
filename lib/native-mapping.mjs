import { matchRegions } from './native-regions.mjs';
// Stable IDs, without depending on Zotero's private PDF.js text-item order.
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function mapNativeSelection(source, selection) {
  const page = selection?.position?.pageIndex;
  if (!Number.isInteger(page) || page < 0 || typeof selection?.text !== 'string' || selection.text.length > 30000) return { ids: [], reason: '选区数据无效' };
  const regions=matchRegions(source,selection);
  if(source.version>=2||source.geometryVersion)return regions||{ids:[],reason:'选区没有可靠区域定位；请核对 layout 报告，不使用文字猜测'};
  // A region supplies a reliable anchor even when math glyph order is broken.
  // Merge text matches below to retain ordinary prose in cross-boundary selections.
  const query = normalize(selection.text);
  if (query.length < 3) return regions || { ids: [], reason: '选区太短或只有符号，请多选几个词' };
  const endPage = page + (selection.position.nextPageRects?.length ? 1 : 0);
  let text = '';
  const refs = [];
  for (const segment of source.segments) {
    if (!segment.locations.some(loc => loc.page >= page + 1 && loc.page <= endPage + 1)) {
      text += '\0'; refs.push(null); continue;
    }
    const value = normalize(segment.source);
    text += value;
    for (let i = 0; i < value.length; i++) refs.push(segment.id);
  }
  const candidates = new Map();
  for (let start = text.indexOf(query); start !== -1; start = text.indexOf(query, start + 1)) {
    const ids = [...new Set(refs.slice(start, start + query.length))];
    candidates.set(ids.join(','), ids);
    if (candidates.size > 1) return regions || { ids: [], reason: '这一页存在多个候选句，请扩大选区后重试' };
  }
  if (!candidates.size) return regions || { ids: [], reason: '未找到对应原句；请扩大选区或核对原文抽取' };
  return { ids: [...new Set([...(regions?.ids||[]),...[...candidates.values()][0]])] };
}
