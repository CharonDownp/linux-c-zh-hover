'use strict';
// Format AI/user explanations containing multiline C snippets without interpreting HTML.
// Original text is left untouched in the offline library and AI cache.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function escapeMarkdown(value) {
  return String(value ?? '').replace(/\\/g,'\\\\').replace(/([`*_{}\[\]()<>#+!|])/g,'\\$1');
}
function looksLikeCode(line) {
  const s=line.trim();
  if(!s)return false;
  if(/^#\s*(?:include|define|if|ifdef|ifndef|else|elif|endif|pragma)\b/.test(s))return true;
  if(/^\/\/|^\/\*|^\*\//.test(s))return true;
  if(/^\(|^\)\s*[,;]?\s*$/.test(s))return true; // multiline function-call arguments
  if(/^[{}]+\s*;?$/.test(s))return true;
  if(/^(?:if|else|for|while|switch|do|return|break|continue)\b/.test(s))return true;
  if(/^(?:typedef\s+)?(?:struct|union|enum)\s+[A-Za-z_]\w*/.test(s))return true;
  if(/^(?:static\s+)?(?:unsigned\s+|const\s+)?(?:void|int|char|size_t|ssize_t|long|short|float|double)\b.*\)\s*$/.test(s))return true;
  // A C statement/declaration may contain comments in Chinese after //.
  const beforeComment=s.split('//')[0].trim();
  if(!/[\u3400-\u9fff]/.test(beforeComment) && /[;{}]\s*$/.test(beforeComment) && /[A-Za-z_]/.test(beforeComment))return true;
  if(!/[\u3400-\u9fff]/.test(beforeComment) && /^(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\s*->\s*[A-Za-z_]\w*)*)\s*(?:=(?!=)|\+=|-=|\+\+|--)/.test(beforeComment))return true;
  return false;
}
function segments(value) {
  const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n');
  const result=[];let plain=[];
  const addPlain=()=>{if(plain.length){const text=plain.join('\n').replace(/^\n+|\n+$/g,'');if(text)result.push({type:'text',text});plain=[];}};
  for(let i=0;i<lines.length;){
    const opening=lines[i].match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/);
    if(opening){
      const marker=opening[1][0],width=opening[1].length;
      let end=i+1;
      while(end<lines.length && !new RegExp(`^\\s*${marker}{${width},}\\s*$`).test(lines[end]))end++;
      if(end<lines.length){
        addPlain();result.push({type:'code',text:lines.slice(i+1,end).join('\n'),lang:opening[2]||'c'});
        i=end+1;continue;
      }
    }
    if(looksLikeCode(lines[i])){
      let end=i+1;
      while(end<lines.length){
        if(looksLikeCode(lines[end])){end++;continue;}
        if(lines[end].trim()==='' && end+1<lines.length && looksLikeCode(lines[end+1])){end++;continue;}
        break;
      }
      addPlain();result.push({type:'code',text:lines.slice(i,end).join('\n'),lang:'c'});
      i=end;continue;
    }
    plain.push(lines[i]);i++;
  }
  addPlain();
  return result;
}
function safeFence(text) {
  const runs=[...text.matchAll(/`+/g)].map(m=>m[0].length);
  return '`'.repeat(Math.max(3,1+Math.max(0,...runs)));
}
function richMarkdown(value) {
  return segments(value).map(part=>{
    if(part.type==='code'){
      const fence=safeFence(part.text);
      return `\n\n${fence}${part.lang}\n${part.text}\n${fence}\n\n`;
    }
    return escapeMarkdown(part.text).replace(/\n{3,}/g,'\n\n').replace(/(?<!\n)\n(?!\n)/g,'  \n');
  }).join('');
}
function richHtml(value) {
  return segments(value).map(part=>part.type==='code'
    ? `<pre class="c-snippet"><code>${escapeHtml(part.text)}</code></pre>`
    : `<span class="rich-prose">${escapeHtml(part.text)}</span>`
  ).join('');
}
module.exports={richMarkdown,richHtml,segments};
