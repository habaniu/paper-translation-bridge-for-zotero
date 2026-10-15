#!/usr/bin/env node
import {constants} from 'node:fs';
import {copyFile, mkdir, open, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, prepareSource} from '../lib/store.mjs';

export async function ensurePaperPdf(directory, originalPdf) {
  const target = path.join(path.resolve(directory), 'paper.pdf');
  if (!originalPdf) {
    await validatePdf(target);
    return {target, copied:false};
  }
  const source = path.resolve(originalPdf);
  await validatePdf(source);
  if (source === target) return {target, copied:false};
  const sourceHash = hash(await readFile(source));
  let existing;
  try {existing = hash(await readFile(target));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (existing) {
    if (existing !== sourceHash) throw new Error('工作目录已有不同版本的 paper.pdf；拒绝覆盖');
    return {target, copied:false};
  }
  await mkdir(path.dirname(target), {recursive:true});
  try {await copyFile(source,target,constants.COPYFILE_EXCL);}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (hash(await readFile(target)) !== sourceHash) throw new Error('工作目录已有不同版本的 paper.pdf；拒绝覆盖');
    return {target, copied:false};
  }
  return {target, copied:true};
}

async function validatePdf(file) {
  const handle = await open(file,'r');
  try {
    const header = Buffer.alloc(5);
    const {bytesRead} = await handle.read(header,0,5,0);
    if (bytesRead !== 5 || header.toString() !== '%PDF-') throw new Error(`不是 PDF 文件：${file}`);
  } finally {await handle.close();}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, option, originalPdf] = process.argv.slice(2);
  if (!directory || (option !== undefined && (option !== '--pdf' || !originalPdf)) || process.argv.length > (option ? 5 : 3)) {
    console.error('用法：node scripts/prepare-paper.mjs <论文工作目录> [--pdf <原始 PDF 路径>]');
    process.exitCode = 1;
  } else {
    try {
      const {target,copied} = await ensurePaperPdf(directory,originalPdf);
      const source = await prepareSource(path.resolve(directory));
      console.log(JSON.stringify({paper:target,copied,source:path.join(path.resolve(directory),'.translation/source.md'),pages:source.pageCount,segments:source.segments.length,warnings:source.warnings||[]},null,2));
    } catch(error) {console.error(error.message);process.exitCode=1;}
  }
}
