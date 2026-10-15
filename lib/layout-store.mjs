import {readFile,mkdir,copyFile,writeFile,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {attachGlyphs,buildLayout,positionsFor,LAYOUT_VERSION} from './layout.mjs';
import {EXTRACTOR_VERSION} from './alignment.mjs';
const exec=promisify(execFile);
const digest=x=>createHash('sha256').update(x).digest('hex');
export async function readLayoutPages(directory){
  const file=path.join(directory,'paper.pdf'),bytes=await readFile(file);
  let glyphs,lastError;
  const interpreters=process.env.PDF_LAYOUT_PYTHON?[process.env.PDF_LAYOUT_PYTHON]:['python3',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')];
  for(const python of interpreters){try{const {stdout}=await exec(python,[fileURLToPath(new URL('../scripts/pdf-glyphs.py',import.meta.url)),file],{maxBuffer:128*1024*1024,timeout:180000});glyphs=JSON.parse(stdout);break;}catch(e){lastError=e;}}
  if(!glyphs)throw new Error('需要 Python + pdfplumber（可用 PDF_LAYOUT_PYTHON 指定解释器）。字形读取失败：'+lastError.message.slice(0,250));
  const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,isEvalSupported:false,verbosity:0});
  try{const pdf=await task.promise,pages=[];
    for(let n=1;n<=pdf.numPages;n++){const p=await pdf.getPage(n),c=await p.getTextContent();
      pages.push(attachGlyphs({page:n,width:p.view[2]-p.view[0],height:p.view[3]-p.view[1],view:p.view,rotation:p.rotate,items:c.items,styles:c.styles},glyphs[n-1]));}
    return {pages,pdfHash:digest(bytes)};
  }finally{await task.destroy();}
}
export function sourceMarkdown(source){return `<!-- source-sha256: ${source.pdfHash} -->\n\n`+source.segments.map(s=>`<!-- ${s.id} -->\n<!-- kind: ${s.kind}${s.label?' '+s.label:''}${s.needsReview?' NEEDS-REVIEW':''} -->\n${s.source}\n`).join('\n');}
export async function draftLayout(directory){
  const {pages,pdfHash}=await readLayoutPages(directory);
  let overrides,reviewOverridesHash=null;
  try{const raw=await readFile(path.join(directory,'.translation/layout-overrides.json'));overrides=JSON.parse(raw);reviewOverridesHash=digest(raw);}catch(e){if(e.code!=='ENOENT')throw e;}
  const layout=buildLayout(pages,{overrides,pdfHash});
  for(const page of pages)if(!page.items.some(i=>i.str?.trim()))layout.issues.push({page:page.page,reason:'扫描页或无文本层，需要 OCR/人工复核'});
  const source={version:2,extractor:LAYOUT_VERSION,itemExtractor:EXTRACTOR_VERSION,reviewOverridesHash,pdfHash,pageCount:pages.length,pageSizes:pages.map(p=>({width:p.width,height:p.height,view:p.view,rotation:p.rotation})),warnings:layout.issues.map(i=>`第 ${i.page||'?'} 页 ${i.id||''}：${i.reason}`),segments:layout.segments,layoutIssues:layout.issues};
  const dir=path.join(directory,'.translation/layout-draft');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'source.json'),JSON.stringify(source));await writeFile(path.join(dir,'source.md'),sourceMarkdown(source));
  await writeFile(path.join(dir,'items.json'),JSON.stringify({pdfHash,itemExtractor:EXTRACTOR_VERSION,pages:pages.map(p=>({page:p.page,items:p.items.flatMap((item,index)=>{
    if(!item.str?.trim())return [];
    const [,,,height,x,y]=item.transform;
    const boxes=item.boxes?.map(b=>b.rect);
    const measured=boxes?.length?[Math.min(...boxes.map(r=>r[0])),Math.min(...boxes.map(r=>r[1])),Math.max(...boxes.map(r=>r[2])),Math.max(...boxes.map(r=>r[3]))]:null;
    return [{index,text:item.str,rect:item.wholeBox||measured||[x,y-Math.abs(height)*.2,x+item.width,y+Math.abs(height)*.8],geometryIssue:item.geometryIssue}];
  })}))}));
  await writeFile(path.join(dir,'report.json'),JSON.stringify({pdfHash,extractor:LAYOUT_VERSION,segments:source.segments.length,positioned:source.segments.filter(s=>s.positions).length,needsReview:source.segments.filter(s=>s.needsReview).length,reviewed:source.segments.filter(s=>s.reviewed).length,equations:source.segments.filter(s=>s.kind==='equation').map(s=>({id:s.id,label:s.label,page:s.locations[0].page,needsReview:s.needsReview,reviewed:s.reviewed})),issues:layout.issues},null,2));
  return {source,pages,dir};
}

// Existing translations are not re-sent to a model. Each old Markdown block
// must have an unambiguous structural mapping, otherwise migration is blocked.
export function planMigration(oldSource,newSource,parsed){
  if(oldSource.pdfHash!==newSource.pdfHash)throw new Error('PDF 校验值不一致，拒绝迁移');
  const oldById=new Map(oldSource.segments.map(s=>[s.id,s]));
  const overlap=(a,b)=>a.some(x=>b.some(y=>x.page===y.page&&x.item===y.item&&x.start<y.end&&x.end>y.start));
  const proposals=[],blocked=[],claimed=new Map();
  for(const [index,f] of parsed.fragments.entries()){
    if(!f.ids.length){proposals.push({ids:[],markdown:f.markdown});continue;}
    const locs=f.ids.flatMap(id=>oldById.get(id)?.locations||[]);
    const candidates=newSource.segments.filter(s=>overlap(locs,s.locations));
    if(!candidates.length){blocked.push({index,ids:f.ids,reason:'没有原文区域'});continue;}
    // Split only explicit display-math and heading boundaries. Never split a
    // Chinese paragraph into sentences to guess source-language correspondence.
    const pieces=f.markdown.split(/(\$\$[\s\S]*?\$\$|^#{1,6}[^\n]*(?:\n|$))/gm).filter(x=>x.trim());
    let remaining=[...candidates];const local=[];let failed=false;
    for(const piece of pieces){
      const value=piece.trim(),equation=value.startsWith('$$'),title=/^#{1,6}\s/.test(value);
      if(!equation&&!title){local.push({markdown:value,prose:true});continue;}
      const label=equation?value.match(/\\tag\{([^}]+)\}/)?.[1]:null;
      const found=remaining.filter(s=>equation?s.kind==='equation'&&label&&s.label===label:s.kind==='heading');
      if(found.length!==1){blocked.push({index,ids:f.ids,reason:equation?'公式标签与区域不唯一':'标题区域不唯一'});failed=true;break;}
      remaining=remaining.filter(s=>s!==found[0]);local.push({ids:[found[0].id],markdown:value});
    }
    const prose=local.filter(p=>p.prose);
    if(!failed){
      if(prose.length===1&&remaining.length&&remaining.every(s=>s.kind==='text'))prose[0].ids=remaining.map(s=>s.id);
      else if(prose.length||remaining.length){blocked.push({index,ids:f.ids,reason:'多个正文段或混合区域需人工确认'});failed=true;}
    }
    if(failed)continue;
    for(const p of local){for(const id of p.ids){if(claimed.has(id))blocked.push({index,ids:f.ids,reason:`新区域 ${id} 跨越多个旧译文块`});claimed.set(id,index);}proposals.push(p);}
  }
  const markdown=`<!-- source-sha256: ${newSource.pdfHash} -->\n\n`+proposals.map(p=>`${p.ids.length?'<!-- '+p.ids.join(' ')+' -->\n':''}${p.markdown}\n`).join('\n');
  return {blocked,markdown,proposals};
}

export function upgradeGeometry(oldSource,newSource,pages){
  if(oldSource.pdfHash!==newSource.pdfHash)throw new Error('PDF 校验值不一致');
  const source=structuredClone(oldSource);source.geometryVersion=2;source.reviewOverridesHash=newSource.reviewOverridesHash||null;
  source.pageSizes=newSource.pageSizes;source.layoutIssues=[...newSource.layoutIssues];
  for(const s of source.segments){
    delete s.positions;delete s.needsReview;
    try{
      const uncertain=newSource.segments.find(n=>n.needsReview&&n.locations.some(a=>s.locations.some(b=>a.page===b.page&&a.item===b.item&&a.start<b.end&&a.end>b.start)));
      if(uncertain)throw new Error(uncertain.needsReview);
      s.positions=positionsFor(s.locations,pages,s.kind);
    }
    catch(e){s.needsReview=e.message;source.layoutIssues.push({id:s.id,reason:e.message});}
  }
  source.targets=newSource.segments.filter(s=>s.kind==='equation'&&s.label&&s.positions).map(s=>({
    ...s,id:`eq-${s.locations[0].page}-${s.label}`,ids:source.segments.filter(old=>old.locations.some(a=>s.locations.some(b=>a.page===b.page&&a.item===b.item&&a.start<b.end&&a.end>b.start))).map(s=>s.id)
  }));
  const seen=new Set();source.targets=source.targets.filter(t=>{if(seen.has(t.id))throw new Error('公式编号在同页重复，需要复核');seen.add(t.id);return t.ids.length;});
  source.warnings=source.layoutIssues.map(i=>`${i.id||''} 第 ${i.page||'?'} 页：${i.reason}`);
  return source;
}

export async function snapshotLayout(directory){
  const result={};
  for(const name of ['.translation/source.json','translated.md','.translation/layout-overrides.json']){
    try{result[name]=digest(await readFile(path.join(directory,name)));}
    catch(e){if(e.code!=='ENOENT')throw e;result[name]=null;}
  }
  return result;
}
export async function applyDraft(directory,source,markdown,expected){
  if(!expected)throw new Error('缺少迁移前快照，拒绝覆盖');
  // Recheck at apply time; never bind to a PDF that changed during extraction.
  if(digest(await readFile(path.join(directory,'paper.pdf')))!==source.pdfHash)throw new Error('PDF 在准备期间变化');
  const backup=path.join(directory,'.translation','backup-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(path.dirname(backup),{recursive:true});
  const lock=path.join(directory,'.translation/layout-migration.lock');await writeFile(lock,JSON.stringify({backup,pdfHash:source.pdfHash}),{flag:'wx'});
  try{
    if(JSON.stringify(await snapshotLayout(directory))!==JSON.stringify(expected))throw new Error('源索引或译文在准备期间已修改，拒绝覆盖；请重新运行');
    await mkdir(backup,{recursive:true});
  }catch(e){await unlink(lock);throw e;}
  const files=['.translation/source.json','.translation/source.md','translated.md','translated.align.json','.translation/layout-overrides.json'];
  // The plugin sees a lock and refuses to mix old IDs with new Markdown.
  try{
    for(const name of files){try{await copyFile(path.join(directory,name),path.join(backup,path.basename(name)));}catch(e){if(e.code!=='ENOENT')throw e;}}
    if(JSON.stringify(await snapshotLayout(directory))!==JSON.stringify(expected))throw new Error('备份期间源文件被修改，停止写入');
    await writeFile(path.join(directory,'.translation/source.json'),JSON.stringify(source));
    await writeFile(path.join(directory,'.translation/source.md'),sourceMarkdown(source));
    if(markdown!==undefined)await writeFile(path.join(directory,'translated.md'),markdown);
    await unlink(lock);
  }catch(e){throw new Error(`迁移未完成，已保留锁阻止读取；备份：${backup}。${e.message}`);}
  return backup;
}
