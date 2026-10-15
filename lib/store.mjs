import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EXTRACTOR_VERSION, parseTranslation } from './alignment.mjs';
import {draftLayout,applyDraft,snapshotLayout} from './layout-store.mjs';

const pending = new Map();
export const hash = data => createHash('sha256').update(data).digest('hex');
export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}
async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export async function prepareSource(directory) {
  directory = path.resolve(directory);
  if (pending.has(directory)) return pending.get(directory);
  const promise = prepare(directory).finally(() => pending.delete(directory));
  pending.set(directory, promise);
  return promise;
}
async function prepare(directory) {
  const expected=await snapshotLayout(directory);
  const bytes = await readFile(path.join(directory, 'paper.pdf'));
  const pdfHash = hash(bytes);
  const cachePath = path.join(directory, '.translation', 'source.json');
  if(await readOptional(path.join(directory,'.translation/layout-migration.lock')))throw new Error('索引迁移未完成，拒绝读取混合版本；请查看迁移锁内的备份路径');
  const existing = await readOptional(cachePath);
  if (existing) {
    const source = JSON.parse(existing);
    const overrides=await readOptional(path.join(directory,'.translation/layout-overrides.json'));
    const overridesChanged=(source.reviewOverridesHash||null)!==(overrides?hash(overrides):null);
    if (source.pdfHash === pdfHash && !overridesChanged && [EXTRACTOR_VERSION,'regions-v1','regions-v2'].includes(source.extractor)) return source;
    if (await readOptional(path.join(directory, 'translated.md'))) {
      if(overridesChanged)throw new Error('版面复核记录已更新；请先生成 migrate-layout --preserve-ids 草稿并核对，再显式应用');
      throw new Error('原 PDF 或解析版本已变化；请核对并另存旧译文后重新准备，不能静默重编号。');
    }
  }
  const {source}=await draftLayout(directory);
  await applyDraft(directory,source,undefined,expected);
  return source;
}

export async function readDocument(directory) {
  const source = await prepareSource(directory);
  const markdown = await readOptional(path.join(directory, 'translated.md'));
  if(await readOptional(path.join(directory,'.translation/layout-migration.lock'))||JSON.stringify(source)!==JSON.stringify(JSON.parse(await readFile(path.join(directory,'.translation/source.json'),'utf8'))))throw new Error('索引正在更新，请重试');
  const parsed = parseTranslation(markdown, source);
  const revision = hash(`${JSON.stringify(source)}\n${markdown}`);
  const result = { ...source, ...parsed, revision, stamp: markdown ? hash(markdown) : 'missing', hasTranslation: !!markdown.trim() };
  const alignPath = path.join(directory, 'translated.align.json');
  const existing = await readOptional(alignPath);
  if (!existing || JSON.parse(existing).revision !== revision) {
    // All positional bookkeeping is produced by code. The agent only writes MD.
    await atomicWrite(alignPath, JSON.stringify({ ...result, fragments: parsed.fragments.map(({ markdown, ...fragment }) => fragment) }, null, 2) + '\n');
  }
  return result;
}

export async function translationStamp(directory) {
  const markdown = await readOptional(path.join(directory, 'translated.md'));
  return markdown ? hash(markdown) : 'missing';
}
