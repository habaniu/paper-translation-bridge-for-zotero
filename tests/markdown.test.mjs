import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { createMarkdown } from '../lib/markdown.mjs';
const md=createMarkdown(MarkdownIt,katex);
test('公式下标、命令及独立公式在 Markdown 解析前保留',()=>{
  const html=md.render('状态 $x_t$ 和 \\(y_i\\)。\n\n$$\n\\sum_{i=1}^{n} x_i^2\n$$');
  assert.match(html,/katex-display/); assert.match(html,/x_t/); assert.doesNotMatch(html,/<em>/); assert.doesNotMatch(html,/katex-error/);
});
test('正文中的 HTML 被转义，图片不触发外网请求，表格正常渲染',()=>{
  const html=md.render('<script>alert(1)</script>\n\n![x](https://example.com/x.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.doesNotMatch(html,/<script>/); assert.doesNotMatch(html,/<img/); assert.match(html,/<table>/);
});
