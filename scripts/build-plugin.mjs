import { mkdir, readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'plugin/manifest.json'), 'utf8'));
for (const field of ['id', 'update_url', 'strict_max_version']) {
  if (!manifest.applications?.zotero?.[field]) throw new Error(`缺少 Zotero 安装清单必填字段：applications.zotero.${field}`);
}
if (new URL(manifest.applications.zotero.update_url).protocol !== 'https:') throw new Error('更新地址必须使用 HTTPS');
await mkdir(path.join(root, 'dist'), { recursive:true });
const target = path.join(root, 'dist', `paper-translation-bridge-${manifest.version}.xpi`);
const stage = await mkdtemp(path.join(os.tmpdir(), 'paper-native-xpi-'));
try {
  for (const file of ['manifest.json', 'bootstrap.js', 'pane.css', 'icon.svg', 'locale']) await cp(path.join(root, 'plugin', file), path.join(stage, file), {recursive:true});
  const core = [];
  for (const file of ['alignment.mjs', 'markdown.mjs', 'native-regions.mjs', 'native-mapping.mjs', 'native-position.mjs']) {
    core.push((await readFile(path.join(root, 'lib', file), 'utf8')).replace(/^import .* from '\.\/native-regions\.mjs';\n/gm,'').replace(/^export /gm, ''));
  }
  await writeFile(path.join(stage, 'core.js'), core.join('\n'));
  await mkdir(path.join(stage, 'vendor'));
  for (const [source, dest] of [
    ['markdown-it/dist/browser/markdown-it.umd.min.js', 'markdown-it.js'],
    ['markdown-it/LICENSE', 'markdown-it-LICENSE'],
    ['katex/dist/katex.min.js', 'katex.js'], ['katex/dist/katex.min.css', 'katex.min.css'],
    ['katex/dist/fonts', 'fonts'], ['katex/LICENSE', 'katex-LICENSE']
  ]) await cp(path.join(root, 'node_modules', source), path.join(stage, 'vendor', dest), {recursive:true});
  // Fresh staging archive: no token, paper, stale archive entries, or Node runtime.
  const archive = path.join(stage, 'plugin.xpi');
  const result = spawnSync('zip', ['-qr', archive, 'manifest.json', 'bootstrap.js', 'core.js', 'pane.css', 'icon.svg', 'locale', 'vendor'], {cwd:stage, stdio:'inherit'});
  if (result.status !== 0) throw new Error('打包失败，请确认系统已安装 zip');
  await cp(archive, target);
} finally { await rm(stage, {recursive:true, force:true}); }
console.log(target);
