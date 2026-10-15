export function createMarkdown(MarkdownIt, katex) {
  const md = MarkdownIt({ html:false, linkify:false, typographer:false });
  const render = (content, displayMode) => katex.renderToString(content, {displayMode,throwOnError:false,trust:false,strict:'ignore'});
  // Parse mathematics before Markdown can interpret underscores/backslashes.
  md.inline.ruler.before('escape','paper_math',(state,silent) => {
    const start=state.pos;
    const opening=state.src.startsWith('\\(',start) ? '\\(' : state.src[start] === '$' ? '$' : null;
    if (!opening || state.src.startsWith('$$',start)) return false;
    const closing=opening === '$' ? '$' : '\\)';
    let end=state.src.indexOf(closing,start+opening.length);
    while(end>0 && state.src[end-1]==='\\' && closing==='$') end=state.src.indexOf(closing,end+1);
    if(end<0 || end>=state.posMax || end===start+opening.length) return false;
    if(!silent) { const token=state.push('paper_math','math',0); token.content=state.src.slice(start+opening.length,end); }
    state.pos=end+closing.length; return true;
  });
  md.block.ruler.before('fence','paper_math_block',(state,startLine,endLine,silent) => {
    const start=state.bMarks[startLine]+state.tShift[startLine];
    const opening=state.src.startsWith('$$',start) ? '$$' : state.src.startsWith('\\[',start) ? '\\[' : null;
    if(!opening) return false;
    const closing=opening === '$$' ? '$$' : '\\]';
    const end=state.src.indexOf(closing,start+2);
    if(end<0 || end>state.bMarks[endLine]) return false;
    let nextLine=startLine;
    while(nextLine<endLine && state.eMarks[nextLine]<end+2) nextLine++;
    if(state.src.slice(end+2,state.eMarks[nextLine]).trim()) return false;
    if(silent) return true;
    const token=state.push('paper_math_block','math',0); token.block=true; token.content=state.src.slice(start+2,end).trim(); token.map=[startLine,nextLine+1];
    state.line=nextLine+1; return true;
  });
  md.renderer.rules.paper_math=(tokens,index)=>render(tokens[index].content,false);
  md.renderer.rules.paper_math_block=(tokens,index)=>render(tokens[index].content,true)+'\n';
  md.renderer.rules.image=(tokens,index)=>md.utils.escapeHtml(tokens[index].content || '[图片]');
  return md;
}
