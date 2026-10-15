#!/usr/bin/env node
import path from 'node:path';
import { prepareSource, readDocument } from './lib/store.mjs';
import {draftLayout,planMigration,applyDraft,upgradeGeometry,snapshotLayout} from './lib/layout-store.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {parseTranslation} from './lib/alignment.mjs';

const [command, argument, ...flags] = process.argv.slice(2);
if (!['prepare', 'align','layout','migrate-layout'].includes(command) || !argument) {
  console.error('用法：node cli.mjs prepare|align|layout|migrate-layout <论文工作目录> [--check] [--preserve-ids] [--apply]');
  process.exitCode = 1;
} else {
  const directory = path.resolve(argument);
  try {
    if(command==='layout'||command==='migrate-layout'){
      const expected=await snapshotLayout(directory);
      let {source,pages,dir}=await draftLayout(directory);
      let plan;
      if(command==='migrate-layout'){
        const old=JSON.parse(await readFile(path.join(directory,'.translation/source.json'),'utf8'));
        const md=await readFile(path.join(directory,'translated.md'),'utf8');
        const parsed=parseTranslation(md,old);if(parsed.errors.length)throw new Error(parsed.errors.join('\n'));
        if(flags.includes('--preserve-ids')){source=upgradeGeometry(old,source,pages);plan={blocked:[],markdown:md};}
        else plan=planMigration(old,source,parsed);
        await writeFile(path.join(dir,'migration-source.json'),JSON.stringify(source));
        await writeFile(path.join(dir,'migration.json'),JSON.stringify({blocked:plan.blocked},null,2));
        await writeFile(path.join(dir,'translated.md'),plan.markdown);
      }
      if(flags.includes('--apply')){
        if(command==='layout')throw new Error('已有文档使用 migrate-layout；新论文使用 prepare');
        if(plan.blocked.length)throw new Error(`迁移有 ${plan.blocked.length} 处歧义，详见 ${dir}/migration.json；旧文件未变`);
        const parsed=parseTranslation(plan.markdown,source);if(parsed.errors.length)throw new Error(parsed.errors.join('\n'));
        console.log('backup:',await applyDraft(directory,source,flags.includes('--preserve-ids')?undefined:plan.markdown,expected));await readDocument(directory);
      }
      console.log(JSON.stringify({draft:dir,segments:source.segments.length,equations:source.segments.filter(s=>s.kind==='equation').length,formulaTargets:source.targets?.length,issues:source.layoutIssues.length,blocked:plan?.blocked.length},null,2));
    } else if (command === 'prepare') {
      const source = await prepareSource(directory);
      console.log(JSON.stringify({ directory, pages: source.pageCount, segments: source.segments.length,
        source: path.join(directory, '.translation/source.md'), warnings: source.warnings }, null, 2));
    } else {
      const result = await readDocument(directory);
      console.log(JSON.stringify({ translated: result.translated, total: result.total,
        missing: result.missing, errors: result.errors, warnings: result.warnings, layoutIssues: result.layoutIssues||[] }, null, 2));
      if (result.errors.length || (flags.includes('--check') && (result.missing.length || result.warnings.length || !result.total || !result.hasTranslation))) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
