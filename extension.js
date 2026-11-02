'use strict';
const vscode=require('vscode');
const crypto=require('node:crypto');
const {docs,topicMap}=require('./builtin-docs');
const {Storage, validName, safeRecord, validateEntry, validateBrief}=require('./lib/storage');
const {explain,cacheKey,endpointFrom,probeApiEndpoint,callCompatibleApi}=require('./lib/ai');
const {briefOf}=require('./lib/brief');
const {symbols,names,inspectSymbol,codeSnippet,variableRecord,isKeyword}=require('./lib/symbols');
const {explainSymbol}=require('./lib/symbol-ai');

let app;
function cfg() {return vscode.workspace.getConfiguration('zhLinuxApiHover');}
function settings() {
  const c=cfg();
  return {baseUrl:(c.get('ai.baseUrl','')||'').trim(),model:(c.get('ai.model','')||'').trim(),
    hoverMode:c.get('ai.hoverMode','manual'),saveMode:c.get('ai.saveMode','manual'),
    cacheEnabled:c.get('ai.cacheEnabled',true),timeoutMs:c.get('ai.timeoutMs',90000),
    retryCount:c.get('ai.retryCount',1),proxyUrl:(c.get('ai.proxyUrl','')||'').trim(),
    detailMode:c.get('hover.detailMode','compact')};
}
// 只检查密钥是否存在，绝不显示、输出或写盘记录密钥内容。
async function apiConfigStatus() {
  const conf=settings();
  let keyPresent=false;
  let storageError='';
  try {keyPresent=Boolean((await app.ctx.secrets.get('aiApiKey')||'').trim());}
  catch(e) {storageError='VS Code 安全密钥存储读取失败：'+(e?.message||'未知错误');}
  const missing=[];
  if (!conf.baseUrl) missing.push('API Base URL');
  if (!conf.model) missing.push('模型名称');
  if (!keyPresent) missing.push('API Key（本扩展的安全存储）');
  return {conf,keyPresent,storageError,missing,ready:missing.length===0 && !storageError};
}
function settingsOverrideNotes(){
  const notes=[];
  for (const k of ['ai.baseUrl','ai.model']) {
    const i=cfg().inspect?.(k);
    if (i && (i.workspaceValue!==undefined || i.workspaceFolderValue!==undefined)) {
      notes.push(k+' 存在工作区设置，可能覆盖用户设置');
    }
  }
  return notes;
}
async function checkAiConfig(){
  const state=await apiConfigStatus();
  const message=[
    'API Base URL：'+(state.conf.baseUrl?'已填写':'未填写'),
    '模型名称：'+(state.conf.model?'已填写':'未填写'),
    'API Key：'+(state.keyPresent?'已保存在此扩展的安全存储':'未找到'),
    ...(state.storageError?[state.storageError]:[]),
    ...settingsOverrideNotes(),
    state.ready?'配置字段已齐全（尚未测试网络连接或模型是否可用）':'待解决：'+state.missing.join('、')
  ].join('\n');
  if (state.ready) {
    await vscode.window.showInformationMessage(message,{modal:true},'知道了');
    return;
  }
  const action=await vscode.window.showWarningMessage(message,{modal:true},'配置地址与模型','设置 API Key');
  if (action==='配置地址与模型') await configureApi();
  else if (action==='设置 API Key') await setApiKey();
}


// 只探测 Chat Completions 路由是否能够建立 HTTP 连接，不发送密钥和付费模型请求。
async function testAiNetwork() {
  const conf=settings();
  if (!conf.baseUrl) {
    vscode.window.showWarningMessage('请先配置 API Base URL，再测试网络连接。');
    return;
  }
  try {
    const info=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'正在测试 AI 服务网络连接（不请求模型）',cancellable:false},
      async()=>await probeApiEndpoint(conf.baseUrl,12000,conf.proxyUrl));
    vscode.window.showInformationMessage(
      `AI 服务网络可达：HTTP ${info.statusCode}，耗时 ${info.elapsedMs} ms。`+
      '（测试使用 GET 请求，不验证密钥、模型或 Chat Completions POST 是否可用；401/404/405 也能说明服务器已响应。）',
      {modal:true},'知道了');
  } catch(e) {
    vscode.window.showErrorMessage('AI 网络测试失败：'+e.message+'。请检查 Ubuntu 网络、代理设置和 Base URL。',{modal:true},'知道了');
  }
}
function escapeMD(s) {return String(s??'').replace(/\\/g,'\\\\').replace(/([`*_{}\[\]()<>#+!|])/g,'\\$1').replace(/\r?\n/g,' ');}
function escHTML(s) {return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function cmdLink(command, name, label) {
  const uri=`command:${command}?${encodeURIComponent(JSON.stringify([name]))}`;
  return `[${label}](${uri})`;
}
function entryCacheKey(name,conf,kind='function',context='') {
  const base=cacheKey(name,conf.baseUrl,conf.model);
  // 函数沿用旧缓存键；普通变量依赖局部代码，不能在不同项目复用同名变量解释。
  if(kind==='function') return base;
  const contextHash=kind==='variable'?crypto.createHash('sha256').update(context).digest('hex'):'';
  return crypto.createHash('sha256').update(JSON.stringify({name,base,kind,contextHash})).digest('hex');
}
function localRecord(name,{kind=null,context=''}={}) {
  if (!validName(name)) return null;
  if (app?.store.offline[name]) return {...app.store.offline[name],symbolKind:app.store.offline[name].symbolKind||symbols[name]?.symbolKind||'function',kind:'offline'};
  if (kind && kind!=='function' && symbols[name]) return {...symbols[name],kind:'built-in'};
  if (Object.prototype.hasOwnProperty.call(docs,name)) return {entry:docs[name],symbolKind:'function',kind:'built-in',source:'内置离线库'};
  if (symbols[name]) return {...symbols[name],kind:'built-in'};
  const conf=settings(), k=kind||'function';
  if (conf.cacheEnabled && conf.baseUrl && conf.model) {
    const key=entryCacheKey(name,conf,k,context), hit=app.store.cache[key];
    if (hit) return {...hit,symbolKind:hit.symbolKind||k,kind:'cache'};
  }
  return null;
}
function symbolTitle(name,kind) {return kind==='function'?`${name}()` : name;}
function isFunction(record){return !record?.symbolKind||record.symbolKind==='function';}
function meaningLabels(record) {
  return isFunction(record)?{parts:'参数',success:'✅ 成功',failure:'❌ 失败/特殊',successFull:'✅ 成功返回',failureFull:'❌ 失败/特殊',proto:'函数原型'}:
    {parts:record.symbolKind==='struct'||record.symbolKind==='union'?'主要成员':'组成/说明',success:'💡 典型用途',failure:'⚠️ 注意事项',successFull:'💡 典型用途',failureFull:'⚠️ 注意事项',proto:'定义/声明'};
}
function briefFor(record) {return record.brief || briefOf(record.entry);}
function markdownFor(name,record,target=null) {
  const [proto,summary,params,success,failure,note]=record.entry;
  const brief=briefFor(record);
  const md=new vscode.MarkdownString();
  const labels=meaningLabels(record);
  md.appendMarkdown(`### ${escapeMD(symbolTitle(name,record.symbolKind))}｜${isFunction(record)?'函数':names[record.symbolKind]||'标识符'}中文速查\n\n`);
  const category=topicMap[name];
  const origin=record.kind==='offline'?'⭐ 用户离线库':record.kind==='cache'?'🤖 AI 缓存':'📚 内置离线库';
  md.appendMarkdown(`*${origin}${category?' · '+escapeMD(category):''}*\n\n`);
  md.appendCodeblock(proto,'c');
  md.appendMarkdown(`\n**作用：** ${escapeMD(brief.summary)}\n\n`);
  md.appendMarkdown(`**${labels.parts}：**\n\n`);
  for (const p of brief.params) md.appendMarkdown(`- ${escapeMD(p)}\n`);
  md.appendMarkdown(`\n**${labels.success}：** ${escapeMD(brief.success)}\n\n`);
  md.appendMarkdown(`**${labels.failure}：** ${escapeMD(brief.failure)}\n\n`);
  if (settings().detailMode==='full') {
    md.appendMarkdown(`---\n\n**📖 完整解释**\n\n`);
    md.appendMarkdown(`**作用：** ${escapeMD(summary)}\n\n`);
    md.appendMarkdown(`**${labels.parts}：**\n\n`);
    for (const p of params) md.appendMarkdown(`- ${escapeMD(p)}\n`);
    md.appendMarkdown(`\n**${labels.successFull}：** ${escapeMD(success)}\n\n`);
    md.appendMarkdown(`**${labels.failureFull}：** ${escapeMD(failure)}\n\n`);
    md.appendMarkdown(`**提醒：** ${escapeMD(note)}\n\n`);
    if (record.evidence) md.appendMarkdown(`*依据：${escapeMD(record.evidence)}*\n\n`);
  }
  md.appendMarkdown(cmdLink('zhLinuxApiHover.showDetail',target||name,'📖 查看完整解释'));
  md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.editExplanation',target||name,'✏️ 编辑解释')}`);
  if (record.kind==='context') md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.explainIdentifier',target||{name,kind:'variable'},'🤖 结合代码让 AI 解释')}`);
  if (record.kind==='cache') md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.saveOffline',target||name,'📌 保存到离线库')}`);
  md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.refreshFunction',target||{name,kind:record.symbolKind||'function'},'🔄 AI 重新解释 / 提要求')}`);
  md.isTrusted={enabledCommands:['zhLinuxApiHover.showDetail','zhLinuxApiHover.saveOffline','zhLinuxApiHover.refreshFunction','zhLinuxApiHover.editExplanation','zhLinuxApiHover.explainIdentifier']};
  return md;
}
function missingMarkdown(name,kind='function',target=null) {
  const md=new vscode.MarkdownString();
  const fn=kind==='function';
  md.appendMarkdown(`**${escapeMD(symbolTitle(name,kind))}｜本地未收录（${escapeMD(names[kind]||'标识符')}）**\n\n`);
  md.appendMarkdown(fn?'是否属于 Linux/C API 尚未验证；如为自定义函数，请优先看其定义。\n\n':'该名称的具体含义需结合声明或上下文确认。查询当前变量时，代码不会未经允许自动发送给 AI。\n\n');
  md.appendMarkdown(`${cmdLink(fn?'zhLinuxApiHover.explainFunction':'zhLinuxApiHover.explainIdentifier',fn?name:(target||{name,kind}),'🤖 AI 查询（可提要求）')}　·　`);
  md.appendMarkdown(`${cmdLink('zhLinuxApiHover.configureApi',name,'⚙️ 配置 AI 接口')}`);
  md.isTrusted={enabledCommands:['zhLinuxApiHover.explainFunction','zhLinuxApiHover.explainIdentifier','zhLinuxApiHover.configureApi']};
  return md;
}
function nameAtCursor() {
  const editor=vscode.window.activeTextEditor;
  if (!editor) return '';
  const pos=editor.selection.active;
  const range=editor.document.getWordRangeAtPosition(pos,/[A-Za-z_]\w*/);
  return range?editor.document.getText(range):'';
}
async function chooseName(name,placeholder='输入 C/C++ 函数、类型、宏或变量名称') {
  if (name && typeof name==='object' && validName(name.name)) return name.name;
  if (typeof name==='string' && validName(name)) return name;
  const cursorName=nameAtCursor();
  const input=await vscode.window.showInputBox({title:'Linux C 中文速查',prompt:placeholder,value:validName(cursorName)?cursorName:'',validateInput:v=>!validName(v)?'请输入符合 C 标识符规则的函数/宏名称':undefined});
  return input?.trim();
}
function recordForTarget(arg) {
  const name=typeof arg==='string'?arg:arg?.name;
  if(!validName(name))return null;
  const kind=arg?.kind||symbols[name]?.symbolKind||'function';
  const editor=vscode.window.activeTextEditor;
  const line=Number.isInteger(arg?.line)?arg.line:editor?.selection?.active?.line;
  const snippet=kind==='variable'&&editor&&Number.isInteger(line)?codeSnippet(editor.document,line):'';
  return localRecord(name,{kind,context:snippet})||app.recent.get(name)||(kind==='variable'?variableRecord(name,snippet):null);
}
function showPanel(name,record) {
  const [proto,summary,params,success,failure,note]=record.entry;
  const panel=vscode.window.createWebviewPanel('zhLinuxApiHoverDetail',`${symbolTitle(name,record.symbolKind)} 中文说明`,vscode.ViewColumn.Beside,{enableScripts:false});
  const origin=record.kind==='offline'?'自定义离线函数库':record.kind==='cache'?'AI 查询缓存':'内置函数库';
  const brief=briefFor(record),labels=meaningLabels(record);
  panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:15px/1.75 system-ui,sans-serif;color:var(--vscode-editor-foreground);padding:20px;max-width:900px;margin:auto}code,pre{font-family:var(--vscode-editor-font-family),monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--vscode-textCodeBlock-background);border-radius:8px}li{margin:4px 0}small{opacity:.7}h1{font-size:1.5em}</style></head><body><h1>${escHTML(symbolTitle(name,record.symbolKind))}</h1><small>${escHTML(origin)} · ${escHTML(topicMap[name]||'C/Linux')}</small><pre>${escHTML(proto)}</pre><h2>快速理解</h2><p><strong>作用：</strong>${escHTML(brief.summary)}</p><ul>${brief.params.map(p=>`<li>${escHTML(p)}</li>`).join('')}</ul><p><strong>${escHTML(labels.success)}：</strong>${escHTML(brief.success)}</p><p><strong>${escHTML(labels.failure)}：</strong>${escHTML(brief.failure)}</p><hr><h2>完整解释</h2><p><strong>作用：</strong>${escHTML(summary)}</p><h2>${escHTML(labels.parts)}</h2><ul>${params.map(p=>`<li>${escHTML(p)}</li>`).join('')}</ul><p><strong>${escHTML(labels.successFull)}：</strong>${escHTML(success)}</p><p><strong>${escHTML(labels.failureFull)}：</strong>${escHTML(failure)}</p><p><strong>注意：</strong>${escHTML(note)}</p><small>依据：${escHTML(record.evidence||record.source||'本地整理')}</small></body></html>`;
}
// 手动 AI 查询时提供多行可选要求；自动悬停继续使用默认策略，不弹窗。
// 关闭窗口/取消不发送请求；空白输入等于沿用默认解释流程。
function promptAiInstructions(name,existing,force=false,symbolKind='function') {
  return new Promise(resolve=>{
    const panel=vscode.window.createWebviewPanel('zhLinuxAiRequirements',
      `AI ${force?'重新解释':'解释'} ${symbolTitle(name,symbolKind)}`,vscode.ViewColumn.Beside,{enableScripts:true});
    const nonce=crypto.randomBytes(18).toString('base64');
    const old=existing?.entry;
    const preview=old?`<details><summary>查看当前解释（用作定向修改的参考）</summary>
      <p><b>作用：</b>${escHTML(old[1])}</p><p><b>参数：</b></p><ul>${old[2].map(v=>`<li>${escHTML(v)}</li>`).join('')}</ul>
      <p><b>成功：</b>${escHTML(old[3])}</p><p><b>失败：</b>${escHTML(old[4])}</p><p><b>备注：</b>${escHTML(old[5])}</p></details>`:'';
    panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font:14px/1.65 system-ui,sans-serif;color:var(--vscode-editor-foreground);max-width:850px;margin:auto;padding:22px}h1{font-size:1.4em}textarea{width:100%;box-sizing:border-box;min-height:140px;padding:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:6px;font:inherit;resize:vertical}button{padding:9px 16px;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:15px}.hint{opacity:.82}details{margin-top:24px;border:1px solid var(--vscode-panel-border);padding:12px;border-radius:6px}li{margin-bottom:4px}#count{font-size:.85em;text-align:right;opacity:.8}</style></head><body>
<h1>🤖 ${force?'重新解释':'解释'} ${escHTML(symbolTitle(name,symbolKind))}</h1>
<p class="hint">补充要求是可选的。留空并点击「按默认规则解释」，就与旧版本的 AI 查询方式相同。</p>
${old?'<p><strong>定向修改：</strong>如果只想修改其中一部分，请明确写出要改什么，其他未指定字段将由插件保留。例如“只缩短 tp 参数的详细解释，其他内容保持不变”。不填写要求时则重新生成完整解释（已有内容仍不会自动覆盖永久离线库）。</p>':'<p>可以填写需要的风格、篇幅和关注点，例如“参数尽量精简，多解释成功/失败返回值”。</p>'}
<label for="req"><strong>我的补充要求（可不填）</strong></label>
<textarea id="req" maxlength="2000" placeholder="例如：只修改失败返回值部分，补充常见 errno；其他解释不要变。"></textarea><div id="count">0 / 2000 字</div>
<div class="actions"><button id="custom">按照我的要求解释</button><button id="default" class="secondary">按默认规则解释</button><button id="cancel" class="secondary">取消</button></div>
${preview}
<script nonce="${nonce}">(function(){const api=acquireVsCodeApi(),box=document.getElementById('req'),count=document.getElementById('count');box.addEventListener('input',()=>count.textContent=box.value.length+' / 2000 字');document.getElementById('custom').addEventListener('click',()=>api.postMessage({type:'run',instructions:box.value.trim()}));document.getElementById('default').addEventListener('click',()=>api.postMessage({type:'run',instructions:''}));document.getElementById('cancel').addEventListener('click',()=>api.postMessage({type:'cancel'}));})();</script></body></html>`;
    let ended=false;
    const complete=value=>{if(ended)return;ended=true;resolve(value);panel.dispose();};
    const handler=panel.webview.onDidReceiveMessage(message=>{
      if(message?.type==='cancel')return complete(undefined);
      if(message?.type!=='run')return;
      if(typeof message.instructions!=='string' || message.instructions.length>2000){vscode.window.showWarningMessage('补充要求不得超过 2000 字');return;}
      complete(message.instructions.trim());
    });
    panel.onDidDispose(()=>{handler.dispose();if(!ended){ended=true;resolve(undefined);}});
  });
}
// 所有词条（内置/AI 缓存/自定义离线）均可在编辑页中修改。
// 编辑结果只保存在用户离线库，不改动扩展内置资料和 AI 原始缓存。
async function editExplanation(arg) {
  const name=await chooseName(arg,'输入要编辑的函数或宏名称');
  if (!name) return;
  const record=recordForTarget(arg);
  if (!record) {
    vscode.window.showWarningMessage(`${name}() 暂无中文说明。请先使用 AI 查询，或在离线库中手动新增。`);
    return;
  }
  const original=record.entry;
  const brief=briefFor(record);
  const isBuiltIn=Object.prototype.hasOwnProperty.call(docs,name)||Boolean(symbols[name]);
  const labels=meaningLabels(record);
  const panel=vscode.window.createWebviewPanel('zhLinuxApiHoverEdit',`编辑 ${symbolTitle(name,record.symbolKind)} 的中文解释`,vscode.ViewColumn.Beside,{enableScripts:true});
  const nonce=crypto.randomBytes(18).toString('base64');
  const origin=record.kind==='offline'?'用户离线库':record.kind==='cache'?'AI 缓存':'内置函数库';
  const field=(id,label,value,rows=2)=>`<label for="${id}">${escHTML(label)}</label><textarea id="${id}" rows="${rows}" maxlength="6000">${escHTML(value)}</textarea>`;
  panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font:14px/1.55 system-ui,sans-serif;color:var(--vscode-editor-foreground);padding:20px;max-width:860px;margin:auto}
label{display:block;font-weight:600;margin:13px 0 5px}textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;padding:9px;font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder)}h1{font-size:1.45em}h2{margin-top:28px;font-size:1.18em}small,.hint{opacity:.78}.actions{position:sticky;bottom:0;padding:12px 0;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-panel-border)}button{cursor:pointer;padding:9px 18px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:5px}button:disabled{opacity:.55;cursor:wait}#status{margin-left:10px}hr{border:0;border-top:1px solid var(--vscode-panel-border);margin-top:24px}
</style></head><body>
<h1>✏️ 编辑 ${escHTML(symbolTitle(name,record.symbolKind))} 中文解释</h1><p class="hint">原始来源：${escHTML(origin)}。点击保存后，新内容覆盖悬停显示；${isBuiltIn?'内置原文不会被修改，可通过删除用户离线覆盖记录恢复。':'历史 AI 缓存不会被修改。'}所有修改仅存储在本机 VS Code 的用户离线库。</p>
<h2>① 简洁版（默认悬停内容）</h2>
${field('b_summary','作用（简洁）',brief.summary,2)}
${field('b_params',labels.parts+'（每行一项）',brief.params.join('\n'),5)}
${field('b_success',labels.success+'（简洁）',brief.success,2)}
${field('b_failure',labels.failure+'（简洁）',brief.failure,2)}
<hr><h2>② 详细版（“查看完整解释”）</h2>
${field('proto',labels.proto,original[0],2)}
${field('summary','完整作用说明',original[1],4)}
${field('params',labels.parts+'（每行一项）',original[2].join('\n'),6)}
${field('success',labels.successFull+'（详细）',original[3],3)}
${field('failure',labels.failureFull+'（详细）',original[4],3)}
${field('note','补充提醒',original[5],5)}
<p class="hint">参数栏每行填写一项；不需要输入方括号、引号或 JSON。保存后再次悬停，即可看到更新。</p>
<div class="actions"><button id="save">💾 保存全部修改</button><span id="status" role="status" aria-live="polite"></span></div>
<script nonce="${nonce}">
(function(){
const vscode=acquireVsCodeApi();
const fields=['b_summary','b_params','b_success','b_failure','proto','summary','params','success','failure','note'];
const save=document.getElementById('save');const status=document.getElementById('status');
save.addEventListener('click',()=>{
 const values={};for(const id of fields)values[id]=document.getElementById(id).value;
 save.disabled=true;status.textContent='正在保存…';vscode.postMessage({type:'save',values});
});
window.addEventListener('message',event=>{
 const msg=event.data;if(!msg||msg.type!=='saveResult')return;
 save.disabled=false;status.textContent=msg.ok?'✅ 保存成功！重新悬停即可看到新内容。':'❌ 保存失败：'+String(msg.error||'未知错误');
});
})();
</script></body></html>`;
  const handler=panel.webview.onDidReceiveMessage(async message=>{
    if (!message || message.type!=='save' || !message.values || typeof message.values!=='object') return;
    try {
      const v=message.values;
      const ids=['b_summary','b_params','b_success','b_failure','proto','summary','params','success','failure','note'];
      if (!ids.every(id=>typeof v[id]==='string' && v[id].length<=6000)) throw new Error('字段无效或过长（单项最多6000字符）');
      const lines=text=>text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      const entry=[v.proto.trim(),v.summary.trim(),lines(v.params),v.success.trim(),v.failure.trim(),v.note.trim()];
      const compact={summary:v.b_summary.trim(),params:lines(v.b_params),success:v.b_success.trim(),failure:v.b_failure.trim()};
      if (!entry[0] || !entry[1] || !entry[3] || !entry[4] || !compact.summary || !compact.success || !compact.failure) throw new Error('原型、作用和返回值不能为空');
      if (!validateEntry(entry) || !validateBrief(compact)) throw new Error('内容格式不合法或参数项过多（最多20项）');
      await app.store.putOffline(name,entry,'用户手动编辑',record.evidence||record.source||'',compact,record.symbolKind||null);
      app.recent.delete(name);
      await panel.webview.postMessage({type:'saveResult',ok:true});
      vscode.window.showInformationMessage(`${name}() 中文解释已保存到用户离线库`);
    }catch(e){await panel.webview.postMessage({type:'saveResult',ok:false,error:e.message});}
  });
  panel.onDidDispose?.(()=>handler.dispose());
}
// 不依赖 Enter 作为唯一提交方式。VS Code Quick Input 在部分输入法或平台上可能不响应 Enter。
// createInputBox 提供明确的「保存」按钮，并在提交时将输入值交给 SecretStorage，绝不写入普通配置。
async function promptSecureKey() {
  const input=vscode.window.createInputBox();
  const saveButton={iconPath:new vscode.ThemeIcon('check'),tooltip:'保存 API Key（无法按 Enter 时点这里）'};
  input.title='设置 / 更新 API Key';
  input.prompt='粘贴密钥后按 Enter，或点击右侧 ✓ 保存按钮；密钥不会写入 settings.json';
  input.placeholder='输入新的 API Key（输入内容隐藏）';
  input.password=true;
  input.ignoreFocusOut=true;
  input.buttons=[saveButton];
  return new Promise(resolve=>{
    let settled=false;
    const subscriptions=[];
    const finish=value=>{
      if(settled)return;
      settled=true;
      input.hide();
      for(const s of subscriptions)s.dispose();
      input.dispose();
      resolve(value);
    };
    const accept=()=>{
      const key=input.value.trim();
      if(!key){input.validationMessage='API Key 不能为空';return;}
      finish(key);
    };
    subscriptions.push(input.onDidAccept(accept));
    subscriptions.push(input.onDidTriggerButton(button=>{if(button===saveButton)accept();}));
    subscriptions.push(input.onDidChangeValue(()=>{input.validationMessage=undefined;}));
    subscriptions.push(input.onDidHide(()=>finish(undefined)));
    input.show();
  });
}
async function storeApiKey(key) {
  await app.ctx.secrets.store('aiApiKey',key);
  const confirm=await app.ctx.secrets.get('aiApiKey');
  if(!confirm || confirm!==key)throw new Error('保存后无法从 SecretStorage 读取到相同的密钥');
}
async function setApiKey() {
  const key=await promptSecureKey();
  if(key===undefined)return;
  try {
    await storeApiKey(key);
    vscode.window.showInformationMessage('API Key 已安全保存且读取验证成功。注意：仅证明本机保存成功，不代表服务端认证通过。');
  }catch(e) {
    vscode.window.showErrorMessage('API Key 保存失败：'+e.message+'。请检查 VS Code 密钥存储环境。');
  }
}
async function deleteApiKey() {
  const choice=await vscode.window.showWarningMessage('确定删除此扩展保存的 API Key 吗？',{modal:true},'确认删除');
  if(choice!=='确认删除')return;
  try{
    await app.ctx.secrets.delete('aiApiKey');
    vscode.window.showInformationMessage('已删除此扩展的 API Key');
  }catch(e){vscode.window.showErrorMessage('删除密钥失败：'+e.message);}
}
async function testAiAuthentication() {
  const state=await apiConfigStatus();
  if(!state.ready){
    vscode.window.showWarningMessage('无法测试鉴权，缺少：'+[...state.missing,...(state.storageError?[state.storageError]:[])].join('、'));
    return;
  }
  const choice=await vscode.window.showInformationMessage(
    '这将使用当前保存的 API Key、模型和地址发送一次真实的 Chat Completions POST 请求，可能消耗少量 Token。要继续吗？',
    {modal:true},'开始测试');
  if(choice!=='开始测试')return;
  try{
    const secret=await app.ctx.secrets.get('aiApiKey');
    const reply=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'正在测试 AI 模型鉴权（真实 POST）',cancellable:false},
      ()=>callCompatibleApi({baseUrl:state.conf.baseUrl,model:state.conf.model,key:secret,
        messages:[{role:'user',content:'请仅回复 OK'}],timeoutMs:Math.min(30000,state.conf.timeoutMs),retryCount:0,proxyUrl:state.conf.proxyUrl}));
    if(reply && reply.trim())vscode.window.showInformationMessage('真实 AI 鉴权测试成功：API 认证通过，模型返回了文本。');
  }catch(e){
    app.output.appendLine('真实 AI 鉴权测试失败：'+e.message);
    const action=await vscode.window.showErrorMessage('真实 AI 鉴权测试失败：'+e.message,'重新设置 API Key','查看网络日志');
    if(action==='重新设置 API Key')await setApiKey();
    else if(action==='查看网络日志')app.output.show(true);
  }
}
async function configureApi() {
  const cur=settings();
  const base=await vscode.window.showInputBox({title:'第 1/3 步：API Base URL',value:cur.baseUrl,placeHolder:'https://api.example.com/v1',prompt:'填写 OpenAI Chat Completions 兼容接口地址，不要填写 Key',ignoreFocusOut:true,validateInput:v=>{try{endpointFrom(v);return undefined;}catch(e){return e.message;}}});
  if (base===undefined) return;
  const model=await vscode.window.showInputBox({title:'第 2/3 步：模型名称',value:cur.model,placeHolder:'提供商的模型 ID',ignoreFocusOut:true,validateInput:v=>v.trim()?undefined:'模型名称不能为空'});
  if (model===undefined) return;
  await cfg().update('ai.baseUrl',base.trim(),vscode.ConfigurationTarget.Global);
  await cfg().update('ai.model',model.trim(),vscode.ConfigurationTarget.Global);
  // 只有真的存过 Key，才允许跳过输入。旧版的“保持已有密钥”可能让空密钥漏过去。
  const previous=await apiConfigStatus();
  const choices=['现在输入 / 更新 API Key',...(previous.keyPresent?['保留已保存的 API Key']:[])];
  const choice=await vscode.window.showQuickPick(choices,{title:'第 3/3 步：API Key',placeHolder:previous.keyPresent?'检测到已有密钥':'当前没有找到已保存的密钥，必须输入一次'});
  if (!choice) {
    vscode.window.showWarningMessage('地址与模型已保存，但你取消了密钥步骤。可用“检查 AI 配置状态”确认缺失项。');
    return;
  }
  if (choice.startsWith('现在')) {
    const key=await promptSecureKey();
    if(key===undefined){vscode.window.showWarningMessage('密钥输入已取消，AI 配置可能仍不完整。');return;}
    try{await storeApiKey(key);}
    catch(e){vscode.window.showErrorMessage('无法保存 API Key：'+e.message);return;}
  }
  const result=await apiConfigStatus();
  if (result.ready) vscode.window.showInformationMessage('AI 配置完整：API 地址、模型和密钥均已读到（尚未验证 API 连通性）。');
  else vscode.window.showWarningMessage('AI 配置仍不完整：'+[...result.missing,...(result.storageError?[result.storageError]:[])].join('、'));
}
const pending=new Map();
async function queryAi(name,{force=false,quiet=false,signal,instructions='',symbolKind='function',codeContext=''}={}) {
  if (!validName(name)) throw new Error('请输入有效的函数/宏名称');
  if (typeof instructions!=='string' || instructions.length>2000)throw new Error('补充要求最多 2000 字');
  const conf=settings();
  const key=entryCacheKey(name,conf,symbolKind,codeContext);
  const hasInstructions=Boolean(instructions.trim());
  // 带补充要求的请求必须绕开已有词条和缓存，否则 AI 根本不会收到要求。
  if (!force && !hasInstructions) {
    const hit=localRecord(name,{kind:symbolKind,context:codeContext});
    if (hit) return hit;
  }
  const previous=hasInstructions ? (app.recent.get(name)||localRecord(name,{kind:symbolKind,context:codeContext})) : null;
  const state=await apiConfigStatus();
  if (!state.ready) {
    const details=[...state.missing,...(state.storageError?[state.storageError]:[])].join('、');
    if (!quiet) {
      const action=await vscode.window.showWarningMessage('AI 配置缺失：'+details,'检查配置','打开设置');
      if (action==='检查配置') await checkAiConfig();
      else if (action==='打开设置') await configureApi();
    }
    throw new Error('AI 配置缺失：'+details);
  }
  const inflightKey=hasInstructions||force ? key+':'+crypto.createHash('sha256').update(instructions+JSON.stringify(previous?.entry||[])+String(force)).digest('hex') : key;
  if (pending.has(inflightKey)) return pending.get(inflightKey);
  const work=(async()=>{
    const secret=await app.ctx.secrets.get('aiApiKey');
    const worker=symbolKind==='function'?explain:(n,a,k,opts)=>explainSymbol(n,symbolKind,a,k,{...opts,codeContext});
    const {entry,brief,evidence}=await worker(name,{baseUrl:conf.baseUrl,model:conf.model,timeoutMs:conf.timeoutMs,retryCount:conf.retryCount,proxyUrl:conf.proxyUrl},secret,
      {signal,instructions,previous,onRetry:info=>app.output.appendLine(`${name}: 第 ${info.attempt} 次请求暂时失败（${info.reason}），正在重试`) });
    if (signal?.aborted) throw new Error('已取消');
    const record={entry,...(brief?{brief}:{}),source:`AI:${name}`,evidence,symbolKind,kind:'cache',updatedAt:new Date().toISOString()};
    app.recent.set(name,record);
    if (conf.cacheEnabled) await app.store.putCache(key,entry,`AI:${name}`,evidence,brief||null,symbolKind==='function'?null:symbolKind);
    if (conf.saveMode==='auto' && symbolKind!=='variable' && !Object.prototype.hasOwnProperty.call(docs,name) && !symbols[name] && !app.store.offline[name]) {
      await app.store.putOffline(name,entry,'AI 自动保存（未人工审核）',evidence,brief||null,symbolKind==='function'?null:symbolKind);
      return {...record,kind:'offline'};
    }
    return record;
  })();
  pending.set(inflightKey,work);
  try{return await work;}finally{pending.delete(inflightKey);}
}
async function explainCommand(arg, force=false,asIdentifier=false) {
  const name=await chooseName(arg); if (!name) return;
  let symbolKind=asIdentifier?(arg?.kind||symbols[name]?.symbolKind||'variable'):(arg?.kind||app.store.offline[name]?.symbolKind||symbols[name]?.symbolKind||'function');
  if(!names[symbolKind])symbolKind='variable';
  const editor=vscode.window.activeTextEditor;
  const atLine=Number.isInteger(arg?.line)?arg.line:editor?.selection?.active?.line;
  const snippet=symbolKind!=='function'&&editor&&Number.isInteger(atLine)?codeSnippet(editor.document,atLine):'';
  let codeContext='';
  // 仅在主动查询时展示要求输入。空要求沿用默认行为；取消则不请求。
  const previous=app.recent.get(name)||localRecord(name,{kind:symbolKind});
  const instructions=await promptAiInstructions(name,previous,force,symbolKind);
  if(instructions===undefined)return;
  if(symbolKind==='variable' && snippet) {
    const permission=await vscode.window.showWarningMessage(`是否发送当前文件附近最多 7 行代码给 AI？此代码可能包含敏感信息，请先核对：\n\n${snippet}` ,{modal:true},'允许发送片段','仅发送名称');
    if(!permission)return;
    if(permission==='允许发送片段')codeContext=snippet;
  }
  try {
    let result;
    await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`查询 ${name}() 的中文函数说明`,cancellable:false},async()=>{
      result=await queryAi(name,{force,instructions,symbolKind,codeContext});
    });
    showPanel(name,result);
    if (result.kind==='cache' && (force||instructions || !previous)) {
      const action=await vscode.window.showInformationMessage(`${symbolTitle(name,symbolKind)} 的 AI 解释已生成${settings().cacheEnabled?'并缓存':''}。${previous?'原离线词条尚未被覆盖。':'可保存为永久离线词条。'}`, '保存到永久离线库');
      if (action) await saveOffline(name);
    }
  } catch(e) {if (!/AI 配置缺失|已取消/.test(e.message)) {
    app.output.appendLine(`${name}(): ${e.message}`);
    const action=await vscode.window.showErrorMessage(`中文函数查询失败：${e.message}`,'查看网络日志','测试真实 AI 鉴权');
    if(action==='查看网络日志')app.output.show(true);
    if(action==='测试真实 AI 鉴权')await testAiAuthentication();
  }}
}
async function saveOffline(arg) {
  const name=await chooseName(arg,'输入要从 AI 缓存保存的函数名称'); if (!name) return;
  const cfgAi=settings();
  const preferred=app.recent.get(name);
  const k=arg?.kind||preferred?.symbolKind||app.store.offline[name]?.symbolKind||symbols[name]?.symbolKind||'function';
  const editor=vscode.window.activeTextEditor;
  const line=Number.isInteger(arg?.line)?arg.line:editor?.selection?.active?.line;
  const context=k==='variable'&&editor&&Number.isInteger(line)?codeSnippet(editor.document,line):'';
  const hit=cfgAi.baseUrl && cfgAi.model? app.store.cache[entryCacheKey(name,cfgAi,k,context)]:null;
  let rec=app.recent.get(name) || hit || app.store.offline[name];
  if (!rec) {
    vscode.window.showWarningMessage(`${name}() 尚无可保存的 AI 缓存，请先使用“AI 查询函数”。`);
    return;
  }
  if (app.store.offline[name] || Object.prototype.hasOwnProperty.call(docs,name) || symbols[name]) {
    const result=await vscode.window.showWarningMessage(`${name}() 已存在离线说明。要用当前 AI 缓存覆盖自定义离线记录吗？`,{modal:true},'确认覆盖');
    if (result!=='确认覆盖') return;
  }
  if((rec.symbolKind||k)==='variable') {
    const okay=await vscode.window.showWarningMessage('普通变量名在不同文件中可能有不同含义。保存后会按名称在所有项目中显示相同解释，确认仍要永久保存吗？',{modal:true},'仍然保存');
    if(okay!=='仍然保存')return;
  }
  await app.store.putOffline(name,rec.entry,'AI 结果 · 用户确认保存',rec.evidence||'',rec.brief||null,(rec.symbolKind||k)==='function'?null:(rec.symbolKind||k));
  vscode.window.showInformationMessage(`已保存 ${name}() 到永久离线函数与宏库，断网也可查看`);
}
async function explainIdentifierCommand(arg) {
  const name=await chooseName(arg);if(!name)return;
  const kind=arg?.kind||symbols[name]?.symbolKind||(/^[A-Z][A-Z0-9_]+$/.test(name)?'macro':/_t$/.test(name)?'typedef':'variable');
  await explainCommand({...((arg&&typeof arg==='object')?arg:{}),name,kind},false,true);
}
async function searchFunctions() {
  const listed=new Set([...Object.keys(docs),...Object.keys(symbols),...Object.keys(app.store.offline)]);
  const items=[{label:'$(sparkle)  AI 查询未收录的标识符',name:null,description:'输入函数、类型、宏或变量名，按需使用 AI'},
    ...[...listed].sort().map(name=>({label:symbolTitle(name,app.store.offline[name]?.symbolKind||symbols[name]?.symbolKind||'function'),name,description:app.store.offline[name]?'自定义离线库':topicMap[name]||names[symbols[name]?.symbolKind]||'C/Linux API',detail:(app.store.offline[name]?.entry||docs[name]||symbols[name]?.entry)[1]}))];
  const item=await vscode.window.showQuickPick(items,{title:`中文标识符速查（${listed.size} 个永久离线条目）`,matchOnDescription:true,matchOnDetail:true});
  if (!item) return;
  if (item.name) showPanel(item.name,localRecord(item.name));
  else await explainIdentifierCommand();
}
async function exportOffline() {
  const uri=await vscode.window.showSaveDialog({title:'导出自定义离线库（不包含 API Key 或 AI 缓存）',defaultUri:vscode.Uri.joinPath(app.ctx.globalStorageUri,'zh-linux-offline-library-export.json'),filters:{'JSON 文件':['json']}});
  if (!uri) return;
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,entries:app.store.offline},null,2));
  await vscode.workspace.fs.writeFile(uri,bytes);
  vscode.window.showInformationMessage(`已导出 ${Object.keys(app.store.offline).length} 个永久离线条目`);
}
async function importOffline() {
  const files=await vscode.window.showOpenDialog({title:'导入离线函数库 JSON',canSelectMany:false,filters:{'JSON 文件':['json']}});
  if (!files?.length) return;
  try {
    const content=JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
    if (content.schemaVersion!==1 || !content.entries || typeof content.entries!=='object') throw new Error('不是有效的离线库导出文件');
    const incoming=safeRecord(content.entries);
    const keys=Object.keys(incoming).filter(validName);
    if (!keys.length) throw new Error('没有有效的函数说明');
    const overlap=keys.filter(k=>app.store.offline[k]).length;
    const yes=await vscode.window.showWarningMessage(`将导入 ${keys.length} 个词条，${overlap} 个将覆盖现有自定义词条。确认吗？`,{modal:true},'导入');
    if (yes!=='导入') return;
    for (const k of keys) app.store.offline[k]=incoming[k];
    await app.store.save('offline-library.json',app.store.offline);
    vscode.window.showInformationMessage(`已导入 ${keys.length} 个词条`);
  }catch(e){vscode.window.showErrorMessage(`导入失败：${e.message}`);}
}
async function editOfflineEntry(name) {
  const original=app.store.offline[name]?.entry || ['', '', [], '', '', ''];
  const fields=[
    ['函数原型 / 宏用法',original[0]],
    ['作用（中文）',original[1]],
    ['参数说明（使用中文分号 ； 分隔）',original[2].join('；')],
    ['成功时返回值的含义',original[3]],
    ['失败 / 特殊返回值的含义',original[4]],
    ['补充提醒',original[5]]
  ];
  const entered=[];
  for (let i=0;i<fields.length;i++) {
    const [field,value]=fields[i];
    const answer=await vscode.window.showInputBox({title:`编辑 ${name}()：${i+1}/6`,prompt:field,value,ignoreFocusOut:true,validateInput:v=>!v.trim() && i<5?'此字段不能为空':undefined});
    if (answer===undefined) return;
    entered.push(answer.trim());
  }
  const entry=[entered[0],entered[1],entered[2].split('；').map(s=>s.trim()).filter(Boolean),entered[3],entered[4],entered[5]];
  await app.store.putOffline(name,entry,'用户手工维护','用户编辑',null,symbols[name]?.symbolKind||null);
  vscode.window.showInformationMessage(`已保存 ${name}() 的自定义离线说明`);
}
async function manageOffline() {
  const choices=[
    {label:'$(book) 浏览自定义离线词条',op:'browse'},
    {label:'$(add) 手动新增函数或宏',op:'new'},
    {label:'$(pencil) 编辑已有函数或宏',op:'update'},
    {label:'$(edit) 打开离线库 JSON 编辑',op:'edit'},
    {label:'$(trash) 删除单个离线词条',op:'delete'},
    {label:'$(cloud-download) 从 AI 缓存保存为离线词条',op:'save'},
    {label:'$(export) 导出自定义离线库',op:'export'},
    {label:'$(file-symlink-directory) 导入自定义离线库',op:'import'},
    {label:'$(refresh) 从 JSON 重新加载',op:'reload'}];
  const choice=await vscode.window.showQuickPick(choices,{title:`管理离线函数与宏库（当前 ${Object.keys(app.store.offline).length} 条）`});
  if (!choice) return;
  switch(choice.op){
    case 'new': {const n=await vscode.window.showInputBox({title:'新增离线函数或宏',prompt:'输入函数/宏名称（例如 custom_init）',validateInput:v=>validName(v)?undefined:'请输入 C 标识符名称'});if(n)await editOfflineEntry(n);break;}
    case 'update': {const n=await vscode.window.showQuickPick([...new Set([...Object.keys(docs),...Object.keys(symbols),...Object.keys(app.store.offline)])].sort(),{title:'选择要编辑的函数（包括内置库）'});if(n)await editExplanation(n);break;}
    case 'browse': {
      const n=await vscode.window.showQuickPick(Object.keys(app.store.offline).sort(),{title:'选择查看的自定义函数/宏'});
      if(n)showPanel(n,localRecord(n));break;
    }
    case 'edit': {
      if (!Object.keys(app.store.offline).length) await app.store.save('offline-library.json',app.store.offline);
      const doc=await vscode.workspace.openTextDocument(app.store.path('offline-library.json'));
      await vscode.window.showTextDocument(doc,{preview:false});
      vscode.window.showInformationMessage('编辑 JSON 后保存（Ctrl+S），再执行“重新载入离线函数库 JSON”以应用修改。');
      break;
    }
    case 'delete': {
      const n=await vscode.window.showQuickPick(Object.keys(app.store.offline).sort(),{title:'选择要删除的离线词条'});
      if (!n) return;
      const yes=await vscode.window.showWarningMessage(`确定删除 ${n}() 的自定义离线说明吗？（不影响内置库）`,{modal:true},'删除');
      if (yes==='删除') {await app.store.removeOffline(n);vscode.window.showInformationMessage(`已删除 ${n}() 的自定义离线说明`);}break;
    }
    case 'save': await saveOffline();break;
    case 'export': await exportOffline();break;
    case 'import': await importOffline();break;
    case 'reload': await app.store.reloadOffline();vscode.window.showInformationMessage('已重新加载离线函数库');break;
  }
}
async function clearCache() {
  const yes=await vscode.window.showWarningMessage('确定清空所有 AI 查询缓存？永久离线库和内置库不会被删除。',{modal:true},'清空缓存');
  if (yes==='清空缓存') {await app.store.clearCache();vscode.window.showInformationMessage('AI 缓存已清空');}
}
async function activate(context) {
  const store=new Storage(context);
  await store.init();
  const output=vscode.window.createOutputChannel('Linux C 中文速查');
  context.subscriptions.push(output);
  app={store,ctx:context,recent:new Map(),output};
  const commands={
    searchFunctions, explainFunction:arg=>explainCommand(arg,false),explainIdentifier:explainIdentifierCommand,refreshFunction:arg=>explainCommand(arg,true),
    saveOffline,manageOffline,editExplanation,configureApi,setApiKey,deleteApiKey,checkAiConfig,testAiNetwork,testAiAuthentication,clearCache,
    showDetail:async arg=>{const name=await chooseName(arg);if(!name)return;const rec=recordForTarget(arg);if(rec)showPanel(name,rec);else vscode.window.showWarningMessage('未找到本地说明，请先进行 AI 查询。');},reloadOffline:async()=>{await store.reloadOffline();vscode.window.showInformationMessage('离线库已经重新载入');},exportOffline,importOffline
  };
  for (const [name,fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`zhLinuxApiHover.${name}`,fn));
  context.subscriptions.push(vscode.languages.registerHoverProvider([{language:'c'},{language:'cpp'}],{
    async provideHover(document,position,token){
      const range=document.getWordRangeAtPosition(position,/[A-Za-z_]\w*/);
      if(!range)return;
      const name=document.getText(range);
      if(!validName(name)||isKeyword(name))return;
      const symbol=inspectSymbol(document,range,name);
      if(!symbol)return;
      const {kind,line,character}=symbol;
      const target={name,kind,line,character};
      const snippet=kind==='variable'?codeSnippet(document,line):'';
      const cached=localRecord(name,{kind,context:snippet});
      if(cached)return new vscode.Hover(markdownFor(name,cached,target),range);
      if(kind==='variable') {
        const inferred=variableRecord(name,snippet);
        if(inferred)return new vscode.Hover(markdownFor(name,inferred,target),range);
      }
      // 未知变量/类型不自动调用 AI，防止鼠标路过大量普通词时耗费额度、泄露代码。
      if(kind!=='function'||settings().hoverMode!=='auto')return new vscode.Hover(missingMarkdown(name,kind,target),range);
      await new Promise(resolve=>setTimeout(resolve,420));
      if(token?.isCancellationRequested)return;
      const abort=new AbortController();
      const disposable=token?.onCancellationRequested?.(()=>abort.abort());
      try {
        const item=await queryAi(name,{quiet:true,signal:abort.signal});
        return token?.isCancellationRequested?undefined:new vscode.Hover(markdownFor(name,item),range);
      }catch(e){
        if(token?.isCancellationRequested)return;
        const md=missingMarkdown(name,kind,target);
        md.appendMarkdown(`\n\n*自动查询失败：${escapeMD(e.message)}*`);
        return new vscode.Hover(md,range);
      }finally{disposable?.dispose();}
    }
  }));
}
function deactivate() {}
module.exports={activate,deactivate, /* testable pure helpers */ markdownFor,missingMarkdown,localRecord,settings,queryAi,promptAiInstructions};
