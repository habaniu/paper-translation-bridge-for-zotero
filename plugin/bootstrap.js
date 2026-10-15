/* Zotero 10 native pane: local reads only; no paper or annotation writes. */
var pane;
var PREF = 'extensions.paper-translation-bridge.';
var HTML = 'http://www.w3.org/1999/xhtml';
function install() {}
function uninstall() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const scope = { atob, btoa, TextDecoder, TextEncoder };
  scope.globalThis = scope;
  for (const file of ['vendor/markdown-it.js', 'vendor/katex.js', 'core.js']) Services.scriptloader.loadSubScript(rootURI + file, scope);
  const instance = pane = { id, rootURI, core: scope, md: scope.createMarkdown(scope.markdownit, scope.katex), alive: true,
    views: new Map(), menus: new Map(), hashes: new Map(), selections: new Map() };
  for (const window of Zotero.getMainWindows()) addMenus(window);
  instance.section = Zotero.ItemPaneManager.registerSection({
    paneID: 'paper-translation', pluginID: id,
    header: { l10nID: 'paper-translation-pane-header', icon: rootURI + 'icon.svg' },
    sidenav: { l10nID: 'paper-translation-pane-header', icon: rootURI + 'icon.svg' },
    onInit: ({doc}) => doc.defaultView.MozXULElement.insertFTLIfNeeded('paper-translation-pane.ftl'),
    onItemChange: props => {
      props.setEnabled(props.tabType !== 'library');
      const view = instance.views.get(props.body);
      if (view) { stopOriginal(view); view.generation++; view.key = ''; view.itemID = null; view.content.replaceChildren(); }
    },
    onRender: props => setupView(instance, props),
    onAsyncRender: props => updateView(instance, props.body),
    onToggle: ({body}) => { const view=instance.views.get(body); if(view && !instance.core.translationVisible(body)) stopOriginal(view); },
    onDestroy: ({body}) => { const view = instance.views.get(body); if (view) { stopOriginal(view); view.generation++; } instance.views.delete(body); }
  });
  if (!instance.section) throw new Error('无法注册论文译文侧栏');
  instance.handler = event => {
    const a = event.params?.annotation;
    if (!instance.alive || !a?.text || !a.position) return;
    for (const view of instance.views.values()) if (readerFor(view)?.itemID === event.reader.itemID && instance.core.translationVisible(view.body)) {
      stopOriginal(view);
      instance.selections.set(event.reader.itemID, { text: a.text, position: JSON.parse(JSON.stringify(a.position)) });
      view.navigateRequested=false;
      view.forceSelection = true; void updateView(instance, view.body);
    }
  };
  Zotero.Reader.registerEventListener('renderTextSelectionPopup', instance.handler, id);
  instance.timer = setInterval(() => {
    for (const view of instance.views.values()) if (view.body.isConnected && view.body.getClientRects().length) void updateView(instance, view.body);
  }, 2500);
  instance.visibilityTimer=setInterval(()=>{
    for(const view of instance.views.values()) if(!instance.core.translationVisible(view.body)) {
      stopOriginal(view); instance.selections.delete(view.itemID);
      for(const node of view.content.querySelectorAll('.pt-selected')) node.classList.remove('pt-selected');
    }
  },100);
}

function stopOriginal(view) {
  view.highlightRevision=(view.highlightRevision||0)+1;
  view.original?.dispose(); view.original=null; view.originalKey=''; view.navigateRequested=false;
}
async function highlightOriginal(instance,view,reader,source,ids,navigate) {
  if(!ids.length || !instance.core.translationVisible(view.body)) {stopOriginal(view);return;}
  const key=source.pdfHash+ids.join(',');
  if(view.originalKey===key && !navigate)return;
  stopOriginal(view);
  const revision=view.highlightRevision;
  const valid=()=>instance.alive && instance.views.get(view.body)===view && revision===view.highlightRevision && readerFor(view)?.itemID===reader.itemID && instance.core.translationVisible(view.body);
  try {
    const original=view.original=instance.core.createOriginalHighlight(reader,(value,target)=>Components.utils.cloneInto(value,target));
    const positions=await original.locate(source,ids);
    if(!valid()) {original.dispose();return;}
    if(navigate) await original.navigate(positions);
    if(!valid()) {original.dispose();return;}
    original.show(positions); view.originalKey=key;
  } catch(error) {
    if(valid()) {stopOriginal(view);view.status.textContent='原文定位失败：'+error.message;}
  }
}

function readerFor(view) {
  const window = view.body.ownerDocument.defaultView;
  const details = view.body.closest('item-details');
  const tabID = details?.tabID || window.Zotero_Tabs?.selectedID;
  return tabID ? Zotero.Reader.getByTabID(tabID) : null;
}
function element(doc, tag, text) {
  const node = doc.createElementNS(HTML, tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function setupView(instance, {body, doc, tabType}) {
  if (tabType === 'library' || instance.views.has(body)) return;
  body.classList.add('pt-host');
  const style = element(doc, 'link'); style.rel = 'stylesheet'; style.href = instance.rootURI + 'pane.css';
  const math = element(doc, 'link'); math.rel = 'stylesheet'; math.href = instance.rootURI + 'vendor/katex.min.css';
  const wrapper = element(doc, 'div'); wrapper.className = 'pt-pane';
  const controls = element(doc, 'div'); controls.className = 'pt-controls';
  const configure = element(doc, 'button', '译文目录');
  configure.addEventListener('click', () => configureDirectory(doc.defaultView));
  const reload = element(doc, 'button', '刷新');
  const status = element(doc, 'div', '正在读取本地译文…'); status.className = 'pt-status'; status.setAttribute('role', 'status');
  const content = element(doc, 'div'); content.className = 'pt-content'; content.setAttribute('tabindex', '0');
  content.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault(); event.stopPropagation();
    const href = link.getAttribute('href');
    if (/^https?:\/\//i.test(href)) Zotero.launchURL(href);
  });
  controls.append(configure, reload); wrapper.append(controls, status, content); body.replaceChildren(style, math, wrapper);
  const view = { body, status, content, generation: 0, busy: false, key: '', itemID: null, forceSelection: true };
  instance.views.set(body, view);
  content.addEventListener('dblclick',event=>{
    const target=event.target.closest('.pt-fragment');
    if(!target || event.target.closest('a') || !instance.core.translationVisible(body))return;
    const ids=target.dataset.ids.split(' ').filter(Boolean);
    if(!ids.length)return;
    event.preventDefault(); stopOriginal(view);
    const reader=readerFor(view); if(!reader)return;
    instance.selections.set(reader.itemID,{ids,targets:target.dataset.target?[target.dataset.target]:undefined});
    view.navigateRequested=true; view.forceSelection=true;
    void updateView(instance,body);
  });
  reload.addEventListener('click', () => { view.key = ''; instance.hashes.clear(); void updateView(instance, body); });
}
async function digestFile(instance, file) {
  const stat = await IOUtils.stat(file);
  const key = `${file}:${stat.size}:${stat.lastModified}`;
  if (instance.hashes.has(key)) return instance.hashes.get(key);
  const bytes = await IOUtils.read(file);
  const digest = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  digest.init(digest.SHA256); digest.update(bytes, bytes.length);
  const hash = Array.from(digest.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  if (instance.hashes.size > 64) instance.hashes.clear();
  instance.hashes.set(key, hash); return hash;
}
async function findPaper(instance, hash) {
  const root = String(Zotero.Prefs.get(PREF + 'papersDirectory', true) || '');
  if (!root) throw new Error('请点击“译文目录”，选择包含各论文子目录的 papers 文件夹');
  const matches = [];
  for (const dir of await IOUtils.getChildren(root)) {
    if ((await IOUtils.stat(dir)).type !== 'directory') continue;
    const sourcePath = PathUtils.join(dir, '.translation', 'source.json');
    if (!await IOUtils.exists(sourcePath)) continue;
    let source;
    try { source = JSON.parse(await IOUtils.readUTF8(sourcePath)); } catch { continue; }
    if (source.pdfHash !== hash) continue;
    if(await IOUtils.exists(PathUtils.join(dir,'.translation','layout-migration.lock')))throw new Error('该论文的区域索引正在迁移或迁移未完成，请核对备份后恢复');
    if (await digestFile(instance, PathUtils.join(dir, 'paper.pdf')) !== hash) continue;
    matches.push({ dir, source });
  }
  if (!matches.length) throw new Error('未找到相同 PDF 的句子索引，请核对 papers 目录及 .translation/source.json');
  if (matches.length > 1) throw new Error('发现多个相同 PDF 的论文目录。请将“译文目录”设为只包含唯一副本的目录');
  return matches[0];
}
async function updateView(instance, body) {
  const view = instance.views.get(body);
  if (!instance.alive || !view) return;
  if (view.busy) { view.pending = true; return; }
  view.busy = true;
  const generation = view.generation;
  const reader = readerFor(view);
  const current = () => instance.alive && instance.views.get(body) === view && generation === view.generation && readerFor(view)?.itemID === reader?.itemID;
  try {
    if (!reader) throw new Error('请在 Zotero 主窗口的 PDF 标签页中打开论文');
    if (view.itemID !== reader.itemID) { stopOriginal(view); view.itemID = reader.itemID; view.key = ''; view.content.replaceChildren(); view.forceSelection = true; }
    const item = Zotero.Items.get(reader.itemID);
    if (!item?.isPDFAttachment()) throw new Error('当前附件不是 PDF');
    const file = await item.getFilePathAsync();
    if (!file) throw new Error('PDF 尚未下载到本机');
    const hash = await digestFile(instance, file);
    const {dir, source} = await findPaper(instance, hash);
    const translated = PathUtils.join(dir, 'translated.md');
    if (!await IOUtils.exists(translated)) throw new Error('尚无 translated.md；生成译文后此栏会自动更新');
    const markdown = await IOUtils.readUTF8(translated);
    if(await IOUtils.exists(PathUtils.join(dir,'.translation','layout-migration.lock'))||JSON.stringify(source)!==JSON.stringify(JSON.parse(await IOUtils.readUTF8(PathUtils.join(dir,'.translation','source.json')))))throw new Error('索引正在更新，请稍后刷新');
    if (!current()) return;
    const key = dir + JSON.stringify(source) + markdown;
    if (key !== view.key) {
      const parsed = instance.core.parseTranslation(markdown, source);
      if (!parsed.bindingValid || parsed.errors.length) throw new Error(parsed.errors.join('\n') || '译文缺少 PDF 校验标记');
      const fragment = body.ownerDocument.createDocumentFragment();
      for (const part of instance.core.translationPieces(parsed.fragments,source)) {
        const node = element(body.ownerDocument, 'section'); node.className = 'pt-fragment'; node.dataset.ids = part.ids.join(' ');
        if(part.target)node.dataset.target=part.target;
        const parsedDOM = new DOMParser().parseFromString(instance.md.render(part.markdown), 'text/html');
        for (const child of parsedDOM.body.childNodes) node.append(body.ownerDocument.importNode(child, true));
        fragment.append(node);
      }
      view.content.replaceChildren(fragment); view.key = key; view.forceSelection = true;
    }
    const selection = instance.selections.get(reader.itemID);
    view.status.textContent = PathUtils.filename(dir) + ' · 选中英文可定位整句译文' + (source.layoutIssues?.length ? ` · ${source.layoutIssues.length} 项版面警告，详见 layout 报告` : '');
    if (selection && instance.core.translationVisible(body)) {
      const match = selection.ids ? {ids:selection.ids,targets:selection.targets} : instance.core.mapNativeSelection(source, selection);
      const ids = new Set(match.ids);
      const nodes = [...view.content.querySelectorAll('.pt-fragment')];
      const selected = nodes.filter(node => match.targets?.length?match.targets.includes(node.dataset.target):node.dataset.ids.split(' ').some(id => ids.has(id)));
      for (const node of nodes) node.classList.toggle('pt-selected', selected.includes(node));
      const covered = new Set(selected.flatMap(node => node.dataset.ids.split(' ')));
      view.status.textContent = match.reason || (match.targets?.length&&!selected.length ? '译文缺少对应公式的唯一标签，无法独立定位' : match.ids.some(id => !covered.has(id)) ? '选区含未翻译或不在翻译范围内的句子' : `已定位 ${match.ids.length} 个原句`);
      if (selected.length && view.forceSelection) centerSelection(view.content, selected);
      const navigate=view.navigateRequested; view.navigateRequested=false;
      // No PDF scrolling for English selections, only for double-clicked Chinese.
      void highlightOriginal(instance,view,reader,source,selected.length ? (match.targets?.length?match.targets:[...covered]) : [],navigate);
      view.forceSelection = false;
    }
  } catch (error) {
    if (current()) { stopOriginal(view); view.status.textContent = error.message; view.content.replaceChildren(); view.key = ''; }
  } finally {
    view.busy = false;
    if (view.pending && instance.alive) { view.pending = false; void updateView(instance, body); }
  }
}
function centerSelection(container, nodes) {
  const box = container.getBoundingClientRect();
  const first = nodes[0].getBoundingClientRect();
  const last = nodes.at(-1).getBoundingClientRect();
  const height = last.bottom - first.top;
  const center = height <= container.clientHeight ? (first.top + last.bottom) / 2 : (first.top + first.bottom) / 2;
  container.scrollTo({ top: container.scrollTop + center - box.top - container.clientHeight / 2, behavior: 'smooth' });
}
function configureDirectory(window) {
  const value = { value: String(Zotero.Prefs.get(PREF + 'papersDirectory', true) || '') };
  if (!Services.prompt.prompt(window, '本地论文译文目录', '填写 papers 文件夹的绝对路径（内部每篇论文一个子目录）', value, null, {})) return;
  const path = value.value.trim().replace(/\/$/, '');
  if (!PathUtils.isAbsolute(path)) { Services.prompt.alert(window, '目录无效', '请输入绝对路径'); return; }
  Zotero.Prefs.set(PREF + 'papersDirectory', path, true);
  pane.hashes.clear();
  for (const view of pane.views.values()) { view.generation++; view.key = ''; view.content.replaceChildren(); void updateView(pane, view.body); }
}
function addMenus(window) {
  if (!pane?.alive || pane.menus.has(window)) return;
  window.MozXULElement.insertFTLIfNeeded('paper-translation-pane.ftl');
  const popup = window.document.getElementById('menu_ToolsPopup');
  if (!popup) return;
  const node = window.document.createXULElement('menuitem'); node.setAttribute('label', '论文译文：本地目录设置');
  node.addEventListener('command', () => configureDirectory(window)); popup.append(node); pane.menus.set(window, node);
}
function onMainWindowLoad({window}) { addMenus(window); }
function onMainWindowUnload({window}) { pane?.menus.get(window)?.remove(); pane?.menus.delete(window); }
function shutdown() {
  if (!pane) return;
  pane.alive = false; clearInterval(pane.timer); clearInterval(pane.visibilityTimer);
  for(const view of pane.views.values())stopOriginal(view);
  Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', pane.handler);
  Zotero.ItemPaneManager.unregisterSection(pane.section);
  for (const node of pane.menus.values()) node.remove();
  pane.views.clear(); pane.hashes.clear(); pane.selections.clear(); pane = null;
}
