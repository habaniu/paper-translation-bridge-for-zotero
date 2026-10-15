// Render diagnostic overlays and a local region-review page with sibling PNGs.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import {EXTRACTOR_VERSION} from '../lib/alignment.mjs';
const args=process.argv.slice(2),directory=path.resolve(args[0]||'.');
const option=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:args[i+1];};
const draft=path.join(directory,'.translation/layout-draft');
const source=JSON.parse(await readFile(option('--source',path.join(draft,'source.json'))));
const selected=args[1]&&!args[1].startsWith('--')?args[1].split(',').map(Number):Array.from({length:source.pageCount},(_,i)=>i+1);
if(selected.some(n=>!Number.isInteger(n)||n<1||n>source.pageCount))throw new Error('复核页码无效');
const out=path.resolve(option('--out',path.join(draft,'review')));await mkdir(out,{recursive:true});
const bytes=await readFile(path.join(directory,'paper.pdf'));
if(createHash('sha256').update(bytes).digest('hex')!==source.pdfHash)throw new Error('复核索引与 PDF 指纹不一致');
let itemData={pages:[]},overrides={version:1,pdfHash:source.pdfHash,itemExtractor:EXTRACTOR_VERSION,regions:[]};
try{itemData=JSON.parse(await readFile(path.join(draft,'items.json')));if(itemData.pdfHash!==source.pdfHash||itemData.itemExtractor!==EXTRACTOR_VERSION)throw new Error('文本项与 PDF 或提取版本不一致');}catch(e){if(e.code!=='ENOENT')throw e;}
try{overrides=JSON.parse(await readFile(path.join(directory,'.translation/layout-overrides.json')));if(overrides.pdfHash!==source.pdfHash||overrides.itemExtractor!==EXTRACTOR_VERSION)throw new Error('已有复核记录不匹配');}catch(e){if(e.code!=='ENOENT')throw e;}
const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,isEvalSupported:false,verbosity:0});
const pdf=await task.promise,data={pdfHash:source.pdfHash,itemExtractor:EXTRACTOR_VERSION,overrides,pages:[],issues:source.layoutIssues||[]};
try{for(const number of selected){
  const page=await pdf.getPage(number),viewport=page.getViewport({scale:1.5});
  const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height)),ctx=canvas.getContext('2d');
  await page.render({canvasContext:ctx,viewport}).promise;
  const image=`page-${number}.png`;await writeFile(path.join(out,image),await canvas.encode('png'));
  const convert=r=>{const [x1,y1]=viewport.convertToViewportPoint(r[0],r[1]),[x2,y2]=viewport.convertToViewportPoint(r[2],r[3]);return [Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1)];};
  const segments=source.segments.filter(s=>s.locations.some(l=>l.page===number)).map(s=>({id:s.id,kind:s.kind,label:s.label,source:s.source,needsReview:s.needsReview,reviewed:s.reviewed,items:[...new Set(s.locations.filter(l=>l.page===number).map(l=>l.item))],rects:(s.positions||s.reviewPositions||[]).filter(p=>p.pageIndex===number-1).flatMap(p=>p.rects.map(convert))}));
  const items=(itemData.pages.find(p=>p.page===number)?.items||[]).map(i=>({...i,rect:convert(i.rect)}));
  data.pages.push({number,width:canvas.width,height:canvas.height,image,segments,items});
  for(const s of segments){ctx.strokeStyle=s.needsReview?'#bc2838':s.kind==='equation'?'#ca6400':s.kind==='heading'?'#1762bc':'#228066';ctx.lineWidth=s.kind==='text'?.8:2;ctx.setLineDash(s.needsReview?[5,3]:[]);
    for(const [x,y,w,h] of s.rects)ctx.strokeRect(x,y,w,h);
    if(s.rects.length&&s.kind!=='text'){ctx.font='12px sans-serif';ctx.fillStyle=ctx.strokeStyle;ctx.fillText(s.id+(s.label?' ('+s.label+')':''),s.rects[0][0],Math.max(12,s.rects[0][1]-3));}}
  await writeFile(path.join(out,`page-${number}-overlays.png`),await canvas.encode('png'));
}}finally{await task.destroy();}
const template=await readFile(new URL('../static/layout-review.html',import.meta.url),'utf8');
await writeFile(path.join(out,'index.html'),template.replace('__REVIEW_DATA__',()=>JSON.stringify(data).replaceAll('<','\\u003c')));
console.log(path.join(out,'index.html'));
