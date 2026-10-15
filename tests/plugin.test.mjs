import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mapNativeSelection } from '../lib/native-mapping.mjs';

test('译文宽度限制在独立宿主内，正文换行且数学区域独立滚动',async()=>{
  const css=await readFile(new URL('../plugin/pane.css',import.meta.url),'utf8');
  const code=await readFile(new URL('../plugin/bootstrap.js',import.meta.url),'utf8');
  assert.match(code,/body\.classList\.add\('pt-host'\)/);
  assert.match(css,/\.pt-host\s*\{[^}]*contain:\s*inline-size/);
  assert.match(css,/\.pt-content\s*\{[^}]*width:\s*100%[^}]*white-space:\s*normal/);
  assert.match(css,/\.pt-fragment \.katex\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/);
  assert.match(css,/\.katex-display > \.katex\s*\{[^}]*width:\s*max-content/);
});

test('译文开头不留居中空白，末尾保留滚动空间',async()=>{
  const css=await readFile(new URL('../plugin/pane.css',import.meta.url),'utf8');
  const content=css.match(/\.pt-content\s*\{([^}]+)\}/)[1];
  assert.match(content,/padding:\s*0\s+8px\s+35vh\s*;/);
});

test('Zotero 安装清单保持必填字段和手动更新边界', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin/manifest.json', import.meta.url)));
  assert.equal(manifest.version, '0.4.3');
  const target = manifest.applications.zotero;
  for (const key of ['id', 'update_url', 'strict_max_version']) assert.ok(target[key]);
  assert.equal(new URL(target.update_url).hostname, 'paper-translation-bridge.invalid');
});

test('分区本地化仅设置属性，不替换包含译文的 DOM 子树', async () => {
  const ftl = await readFile(new URL('../plugin/locale/en-US/paper-translation-pane.ftl',import.meta.url),'utf8');
  assert.match(ftl, /^paper-translation-pane-header =\s*\n/m);
  assert.match(ftl, /\.label = \{ "" \}/);
  assert.ok(!ftl.includes('论文译文'));
});

const source = { segments: [
  {id:'s00001', source:'Our model is efficient.', locations:[{page:1}]},
  {id:'s00002', source:'It learns new skills.', locations:[{page:1}]},
  {id:'s00003', source:'Our model is efficient.', locations:[{page:2}]},
  {id:'s00004', source:'A different model is robust.', locations:[{page:2}]}
] };
const selection = (text, pageIndex = 0, extra = {}) => ({text, position:{pageIndex, ...extra}});
test('本地定位：半句、跨句、跨页、连字与断行、重复拒绝', () => {
  assert.deepEqual(mapNativeSelection(source, selection('model is')).ids, ['s00001']);
  assert.deepEqual(mapNativeSelection(source, selection('efficient. It learns')).ids, ['s00001','s00002']);
  assert.deepEqual(mapNativeSelection(source, selection('new skills. Our model',0,{nextPageRects:[[1,2,3,4]]})).ids, ['s00002','s00003']);
  assert.deepEqual(mapNativeSelection(source, selection('efﬁ-\ncient')).ids, ['s00001']);
  assert.deepEqual(mapNativeSelection(source, selection('model',1)).ids, []);
  assert.deepEqual(mapNativeSelection(source, selection('zzzz')).ids, []);
  assert.deepEqual(mapNativeSelection(source, selection('is')).ids, []);
  assert.deepEqual(mapNativeSelection(source, selection('model',-1)).ids, []);
});

test('原生侧栏注册、选区监听、本地哈希、卸载清理；不调用 HTTP', async () => {
  const code = await readFile(new URL('../plugin/bootstrap.js', import.meta.url),'utf8');
  let options, handler, removed=false, paneRemoved=false, timerRemoved=false;
  const context = vm.createContext({
    atob, btoa, TextDecoder, TextEncoder,
    Zotero:{initializationPromise:Promise.resolve(),getMainWindows:()=>[],
      ItemPaneManager:{registerSection:o=>{options=o;return 'pane-id';},unregisterSection:id=>{assert.equal(id,'pane-id');paneRemoved=true;}},
      Reader:{registerEventListener:(type,fn)=>{assert.equal(type,'renderTextSelectionPopup');handler=fn;},unregisterEventListener:()=>{removed=true;}},
      Prefs:{get:()=>''}
    },
    Services:{scriptloader:{loadSubScript:(url,target)=>{target.createMarkdown=()=>({});}}},
    setInterval:()=>1, clearInterval:()=>{timerRemoved=true;},
    IOUtils:{stat:async()=>({size:3,lastModified:1}),read:async()=>new Uint8Array([1,2,3])},
    Cc:{'@mozilla.org/security/hash;1':{createInstance:()=>{let d;return {SHA256:1,init:()=>{d=createHash('sha256');},update:b=>d.update(b),finish:()=>d.digest('latin1')};}}}, Ci:{nsICryptoHash:{}}
  });
  vm.runInContext(code,context); await context.startup({id:'test',rootURI:'file:///plugin/'});
  assert.equal(options.paneID,'paper-translation');
  let enabled; options.onItemChange({tabType:'library',setEnabled:v=>{enabled=v;}}); assert.equal(enabled,false);
  options.onItemChange({tabType:'pdf',setEnabled:v=>{enabled=v;}}); assert.equal(enabled,true);
  handler({reader:{itemID:12},params:{annotation:selection('model')}});
  assert.equal(context.pane.selections.size,0); // No visible pane: ignore selection.
  assert.equal(await context.digestFile(context.pane,'/fake/paper.pdf'), createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex'));
  await assert.rejects(()=>context.findPaper(context.pane,'hash'), /papers/);
  context.shutdown(); assert.ok(removed && paneRemoved && timerRemoved);
  assert.equal(context.pane,null);
});

test('居中只滚动译文容器；跨屏优先首句', async () => {
  const ctx=vm.createContext({}); vm.runInContext(await readFile(new URL('../plugin/bootstrap.js',import.meta.url),'utf8'),ctx);
  let scroll;
  const box={clientHeight:400,scrollTop:100,getBoundingClientRect:()=>({top:50}),scrollTo:o=>{scroll=o;}};
  const node=(top,bottom)=>({getBoundingClientRect:()=>({top,bottom})});
  ctx.centerSelection(box,[node(500,550),node(600,650)]); assert.equal(scroll.top,425);
  ctx.centerSelection(box,[node(500,550),node(1000,1050)]); assert.equal(scroll.top,375);
});

test('打包用浏览器库及纯 JS 核心可加载并安全渲染公式', async () => {
  const ctx = vm.createContext({atob, btoa, TextDecoder, TextEncoder});
  for (const file of ['node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'node_modules/katex/dist/katex.min.js', 'lib/alignment.mjs', 'lib/markdown.mjs', 'lib/native-regions.mjs', 'lib/native-mapping.mjs', 'lib/native-position.mjs']) {
    const code = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    vm.runInContext(file.startsWith('lib/') ? code.replace(/^import .* from '\.\/native-regions\.mjs';\n/gm,'').replace(/^export /gm,'') : code, ctx);
  }
  const html=vm.runInContext('createMarkdown(markdownit,katex).render("$x_1$ <script>alert(1)</script>")',ctx);
  assert.match(html,/katex/); assert.ok(!html.includes('<script>'));
  assert.equal(typeof ctx.parseTranslation,'function'); assert.equal(typeof ctx.mapNativeSelection,'function');
});

test('本地文件发现：校验 PDF、拒绝副本歧义及过期源索引', async () => {
  const bytes=new Uint8Array([1,2,3]); const hash=createHash('sha256').update(bytes).digest('hex');
  let duplicate=false, stale=false;
  const ctx=vm.createContext({PathUtils:path,
    Zotero:{Prefs:{get:()=>'/papers'}},
    IOUtils:{getChildren:async()=>duplicate ? ['/papers/a','/papers/b'] : ['/papers/a'],
      stat:async()=>({type:'directory',size:3,lastModified:1}), exists:async p=>!p.endsWith('layout-migration.lock'),
      readUTF8:async()=>JSON.stringify({pdfHash:stale ? 'wrong' : hash}),read:async()=>bytes},
    Cc:{'@mozilla.org/security/hash;1':{createInstance:()=>{let d;return {SHA256:1,init:()=>{d=createHash('sha256');},update:b=>d.update(b),finish:()=>d.digest('latin1')};}}}, Ci:{nsICryptoHash:{}}
  });
  vm.runInContext(await readFile(new URL('../plugin/bootstrap.js',import.meta.url),'utf8'),ctx);
  const instance={hashes:new Map()};
  assert.equal((await ctx.findPaper(instance,hash)).dir,'/papers/a');
  duplicate=true; await assert.rejects(()=>ctx.findPaper(instance,hash),/多个/);
  stale=true; await assert.rejects(()=>ctx.findPaper(instance,hash),/未找到/);
});

test('标签归属优先 item-details，避免后台标签被当前窗口覆盖', async () => {
  const ctx=vm.createContext({Zotero:{Reader:{getByTabID:id=>({itemID:id})}}});
  vm.runInContext(await readFile(new URL('../plugin/bootstrap.js',import.meta.url),'utf8'),ctx);
  const view={body:{ownerDocument:{defaultView:{Zotero_Tabs:{selectedID:'current'}}},closest:()=>({tabID:'background'})}};
  assert.equal(ctx.readerFor(view).itemID,'background');
});
