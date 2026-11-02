'use strict';
const {symbols}=require('../symbol-docs');
const validName=name=>typeof name==='string' && /^[A-Za-z_]\w{0,127}$/.test(name);
const keywords=new Set(('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Complex _Imaginary alignas alignof bool class namespace public private protected virtual template typename using new delete nullptr true false try catch throw constexpr static_cast reinterpret_cast const_cast dynamic_cast').split(' '));
const names={function:'函数',struct:'结构体',union:'联合体',enum:'枚举',typedef:'类型别名',macro:'宏/常量',member:'结构体成员',variable:'变量'};
function isKeyword(name){return keywords.has(name);}
function guessKind(name,before='',after='') {
  if(!validName(name) || isKeyword(name))return null;
  if(/^\s*\(/.test(after))return 'function';
  if(symbols[name])return symbols[name].symbolKind;
  if(/\bstruct\s+$/.test(before))return 'struct';
  if(/\bunion\s+$/.test(before))return 'union';
  if(/\benum\s+$/.test(before))return 'enum';
  if(/(?:\.|->)\s*$/.test(before))return 'member';
  if(/^[A-Z][A-Z0-9_]+$/.test(name))return 'macro';
  if(/_t$/.test(name))return 'typedef';
  return 'variable';
}
function isProbablyCode(line,offset) {
  const left=String(line).slice(0,offset);
  // Heuristic only. Keep obvious comments, strings, and #include out of hover.
  if(/^\s*#\s*include\b/.test(line))return false;
  if(/^\s*(?:\/\/|\*|\/\*)/.test(line))return false;
  if(left.lastIndexOf('//')>=0)return false;
  if(left.lastIndexOf('/*')>left.lastIndexOf('*/'))return false;
  let quote=null,escaped=false;
  for(let i=0;i<left.length;i++){
    const ch=left[i];
    if(escaped){escaped=false;continue;}
    if(ch==='\\' && quote){escaped=true;continue;}
    if(quote){if(ch===quote)quote=null;}
    else if(ch==='"'||ch==="'")quote=ch;
  }
  return !quote;
}
function inspectSymbol(document,range,name) {
  if (!validName(name)||isKeyword(name)||!document?.lineAt||!range?.end)return null;
  const start=range.start||{line:range.end.line,character:Math.max(0,range.end.character-name.length)};
  const line=document.lineAt(start.line).text;
  if(!isProbablyCode(line,start.character))return null;
  const before=line.slice(0,start.character);
  const after=line.slice(range.end.character);
  return {name,kind:guessKind(name,before,after),line:start.line,character:start.character};
}
function codeSnippet(document,line, radius=3, maxChars=1400) {
  if(!document?.lineAt||!Number.isInteger(line))return '';
  const total=Number.isInteger(document.lineCount)?document.lineCount:line+1;
  const lines=[];
  for(let i=Math.max(0,line-radius);i<=Math.min(total-1,line+radius);i++){
    try {lines.push(`${i+1}: ${document.lineAt(i).text}`);} catch{break;}
  }
  return lines.join('\n').slice(0,maxChars);
}
function declarationFor(name,snippet) {
  if(!validName(name))return null;
  // Finds simple single-line declarations; not a full C parser. Never claim runtime values.
  const esc=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const decl=new RegExp(`\\b((?:(?:const|volatile|static|extern|unsigned|signed)\\s+)*(?:struct\\s+[A-Za-z_]\\w*|union\\s+[A-Za-z_]\\w*|enum\\s+[A-Za-z_]\\w*|[A-Za-z_]\\w*))\\s*([*\\s]*)\\b${esc}\\b`);
  const lines=String(snippet||'').split('\n');
  for(const line of lines){
    const content=line.replace(/^\d+:\s*/,'').trim();
    if(content.startsWith('//')||content.startsWith('#'))continue;
    const match=decl.exec(content);
    if(match && !/\b(?:return|if|while|for|case|else|sizeof)\b/.test(match[1]))return {type:(match[1]+match[2]).trim(),statement:content.slice(0,220)};
  }
  return null;
}
function variableRecord(name,snippet) {
  const decl=declarationFor(name,snippet);
  if(!decl)return null;
  const typeSymbol=decl.type.match(/(?:struct|union|enum)\s+(\w+)/)?.[1]||decl.type.replace(/[\s*]+/g,'');
  const related=symbols[typeSymbol];
  const more=related?related.entry[1]:'具体作用由它所在的代码决定';
  return {symbolKind:'variable',kind:'context',source:'当前文件声明（本地推断，未调用 AI）',
    entry:[decl.statement,`变量 ${name}，声明类型为 ${decl.type}。${more}`,
      [`类型：${decl.type}`],`可作为 ${decl.type} 类型的数据使用；具体值与用途取决于执行过程。`,
      '只根据声明判断类型，不代表已知道变量当前的值。','如需解释变量在当前程序中的实际角色，可点击 AI 查询并明确同意附带附近代码。']};
}
module.exports={symbols,keywords,names,isKeyword,guessKind,inspectSymbol,codeSnippet,declarationFor,variableRecord};
