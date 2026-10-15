// All offsets use UTF-16, matching browser Range offsets and PDF.js TextItems.
export const FORMAT_VERSION = 1;
export const EXTRACTOR_VERSION = 'pdfjs-6.3.289-lines-v2';
const abbreviations = /(?:\b(?:figs?|eqs?|secs?|refs?|dr|mr|mrs|prof|vs|cf|no|vol|pp|inc)|et al|e\.g|i\.e)\.$/i;

export function sentenceRanges(text) {
  const ranges = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]+[”’"')\]]*(?:\s+|$)/g)) {
    const end = match.index + match[0].trimEnd().length;
    const prefix = text.slice(start, end);
    // Do not split paper abbreviations, initials, decimals or numbered headings.
    if (abbreviations.test(prefix) || /\b[A-Z]\.$/.test(prefix) || /^\s*\d+(?:\.\d+)*\.$/.test(prefix)) continue;
    const next = text.slice(match.index + match[0].length).trimStart();
    if (next && /^[a-z]/.test(next)) continue;
    ranges.push({ start, end });
    start = match.index + match[0].length;
  }
  if (text.slice(start).trim()) ranges.push({ start, end: text.length });
  return ranges.map(({ start, end }) => {
    while (/\s/.test(text[start] || '') && start < end) start++;
    while (/\s/.test(text[end - 1] || '') && end > start) end--;
    return { start, end };
  }).filter(r => r.end > r.start);
}

// Geometric line ordering: retain PDF.js item IDs rather than locating text by
// string search (which fails on repeated sentences).
export function pageLines(items, width, page) {
  const usable = items.map((item, index) => ({ ...item, index }))
    .filter(item => typeof item.str === 'string' && item.str.trim());
  const rows = [];
  for (const item of usable.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const y = item.transform[5];
    const row = rows.find(r => Math.abs(r.y - y) < Math.max(2, Math.min(item.height || 8, r.height) * .35));
    if (row) row.items.push(item);
    else rows.push({ y, height: item.height || 8, items: [item] });
  }
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let line;
    for (const item of row.items) {
      const x = item.transform[4];
      const columnSeam = line && line.right <= width / 2 + 3 && x >= width / 2 + 3 && x - line.right > Math.max(6, row.height * .6);
      if (!line || columnSeam || x - line.right > Math.max(18, row.height * 2)) {
        line = { page, y: row.y, height: row.height, left: x, right: x, items: [] };
        lines.push(line);
      }
      line.items.push(item);
      line.right = Math.max(line.right, x + item.width);
    }
  }
  const middle = width / 2;
  const left = lines.filter(l => l.right < middle + 8 && l.left < middle - 35 && l.right - l.left > width * .25);
  const right = lines.filter(l => l.left > middle - 8 && l.right - l.left > width * .25);
  if (left.length < 4 || right.length < 4) return lines.sort((a, b) => b.y - a.y || a.left - b.left);
  // Full-width titles/figures split a page into bands, each read left then right.
  const spanning = lines.filter(l => l.left < middle - 20 && l.right > middle + 20).sort((a, b) => b.y - a.y);
  const output = [];
  let top = Infinity;
  for (const divider of [...spanning, { y: -Infinity }]) {
    const band = lines.filter(l => !spanning.includes(l) && l.y <= top && l.y > divider.y);
    output.push(...band.filter(l => l.left < middle).sort((a, b) => b.y - a.y || a.left - b.left));
    output.push(...band.filter(l => l.left >= middle).sort((a, b) => b.y - a.y || a.left - b.left));
    if (divider.y !== -Infinity) output.push(divider);
    top = divider.y;
  }
  return output;
}

function lineText(line) {
  let text = '';
  const refs = [];
  let previous;
  for (const item of line.items) {
    const gap = previous ? item.transform[4] - (previous.transform[4] + previous.width) : 0;
    if (text && !/\s$/.test(text) && !/^\s/.test(item.str) && gap > Math.max(.7, line.height * .12)) {
      text += ' '; refs.push(null);
    }
    for (let offset = 0; offset < item.str.length; offset++) {
      text += item.str[offset];
      refs.push({ page: line.page, item: item.index, offset });
    }
    previous = item;
  }
  return { text, refs };
}

// Emit structural regions before joining prose or splitting it into sentences.
// PDF.js item indexes remain unchanged for migrations of existing translations.
function* readingUnits(pages, regions) {
  const owners = new Map(), emitted = new Set();
  for (const region of regions) for (const item of region.items) owners.set(`${region.page}:${item}`,region);
  for (const page of pages) for (const line of pageLines(page.items,page.width,page.page)) {
    let run=[];
    const proseLine=()=>({...line,items:run,left:run[0].transform[4],right:Math.max(...run.map(i=>i.transform[4]+i.width))});
    for (const item of line.items) {
      const region=owners.get(`${page.page}:${item.index}`);
      if (!region) {run.push(item);continue;}
      if (run.length) {yield {line:proseLine(),page};run=[];}
      if (!emitted.has(region)) {emitted.add(region);yield {region};}
    }
    if (run.length) yield {line:proseLine(),page};
  }
}

export function buildSegments(pages, {regions=[]}={}) {
  const blocks = [];
  let current = null;
  let previous = null;
  for (const unit of readingUnits(pages,regions)) {
      if (unit.region) {blocks.push({region:unit.region});current=null;previous=null;continue;}
      const {page,line}=unit;
      const data = lineText(line);
      const value = data.text.trim();
      if (!value) continue;
      // Ignore standalone page numbers, but retain bibliography and figure text.
      if (/^\d{1,6}$/.test(value) && (line.y < 50 || line.y > page.height - 30)) continue;
      const heading = /^(abstract|references|acknowledg(e)?ments|appendix|\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z -]{2,70})$/i.test(value);
      const gap = previous ? previous.y - line.y : 0;
      const pageBreak = previous && previous.page !== line.page;
      const columnBreak = previous && gap < -20;
      const continuation = current && !/[.!?:]["')\]]*$/.test(current.text.trimEnd());
      const newBlock = !current || heading || current.heading ||
        (!pageBreak && !columnBreak && gap > Math.max(19, line.height * 1.7)) ||
        ((pageBreak || columnBreak) && !continuation);
      if (newBlock) {
        current = { text: '', refs: [], heading };
        blocks.push(current);
      }
      if (current.text) {
        if (/[A-Za-z]-$/.test(current.text) && /^[a-z]/.test(data.text)) {
          current.text = current.text.slice(0, -1); current.refs.pop();
        } else { current.text += ' '; current.refs.push(null); }
      }
      current.text += data.text; current.refs.push(...data.refs);
      previous = line;
  }
  const segments = [];
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.region) {
      const r=block.region,items=pages[r.page-1].items;
      const locations=r.items.map(item=>({page:r.page,item,start:0,end:items[item].str.length}));
      segments.push({id:`s${String(segments.length+1).padStart(5,'0')}`,block:blockIndex+1,
        kind:r.kind,label:r.label,needsReview:r.needsReview,reviewed:r.reviewed,
        source:r.items.map(i=>items[i].str).join(' '),locations});
      continue;
    }
    const ranges = block.heading ? [{ start: 0, end: block.text.length }] : sentenceRanges(block.text);
    for (const range of ranges) {
      const locations = [];
      for (const ref of block.refs.slice(range.start, range.end)) {
        if (!ref) continue;
        const last = locations.at(-1);
        if (last && last.page === ref.page && last.item === ref.item && last.end === ref.offset) last.end++;
        else locations.push({ page: ref.page, item: ref.item, start: ref.offset, end: ref.offset + 1 });
      }
      segments.push({ id: `s${String(segments.length + 1).padStart(5, '0')}`, block: blockIndex + 1,
        kind: block.heading ? 'heading' : 'text', source: block.text.slice(range.start, range.end).trim(), locations });
    }
  }
  return segments;
}

export function parseTranslation(markdown, source) {
  const matches = [...markdown.matchAll(/<!--\s*(s\d{5,}(?:[\s,]+s\d{5,})*)\s*-->/g)];
  const known = new Set(source.segments.map(s => s.id));
  const seen = new Set();
  const errors = [];
  const fragments = [];
  const binding = markdown.match(/<!--\s*source-sha256:\s*([a-f0-9]{64})\s*-->/);
  if (markdown.trim() && !binding) errors.push('译文缺少 source-sha256 标记；请复制 source.md 顶部的标记。');
  if (binding && binding[1] !== source.pdfHash) errors.push('译文对应的 PDF 已发生变化，请重新核对句子编号。');
  const prefix = markdown.slice(0, matches[0]?.index ?? markdown.length).replace(/<!--[^]*?-->/g, '').trim();
  if (prefix) fragments.push({ ids: [], markdown: prefix, start: 0, end: matches[0]?.index ?? markdown.length });
  for (const [index, match] of matches.entries()) {
    const ids = match[1].split(/[\s,]+/);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end).trim();
    for (const id of ids) {
      if (!known.has(id)) errors.push(`未知句子编号：${id}`);
      if (seen.has(id)) errors.push(`重复句子编号：${id}`);
      if (content) seen.add(id);
    }
    if (!content) errors.push(`译文为空：${ids.join(', ')}`);
    fragments.push({ ids, markdown: content, start, end });
  }
  return { fragments, errors, missing: [...known].filter(id => !seen.has(id)), translated: [...seen].filter(id => known.has(id)).length,
    total: known.size, bindingValid: !!binding && binding[1] === source.pdfHash };
}

export function matchingIds(segments, selections) {
  return segments.filter(s => s.locations.some(loc => selections.some(sel =>
    sel.page === loc.page && sel.item === loc.item && sel.start < loc.end && sel.end > loc.start))).map(s => s.id);
}
