'use strict';
const vscode=require('vscode');
const crypto=require('node:crypto');
const {docs,topicMap}=require('./builtin-docs');
const {Storage, validName, safeRecord, validateEntry, validateBrief}=require('./lib/storage');
const {explain,cacheKey,endpointFrom,probeApiEndpoint}=require('./lib/ai');
const {briefOf}=require('./lib/brief');

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
function localRecord(name) {
  if (!validName(name)) return null;
  if (app?.store.offline[name]) return {...app.store.offline[name],kind:'offline'};
  if (Object.prototype.hasOwnProperty.call(docs,name)) return {entry:docs[name],kind:'built-in',source:'内置离线库'};
  const set=settings();
  if (set.cacheEnabled && set.baseUrl && set.model) {
    const key=cacheKey(name,set.baseUrl,set.model), hit=app.store.cache[key];
    if (hit) return {...hit,kind:'cache'};
  }
  return null;
}
function briefFor(record) {return record.brief || briefOf(record.entry);}
function markdownFor(name,record) {
  const [proto,summary,params,success,failure,note]=record.entry;
  const brief=briefFor(record);
  const md=new vscode.MarkdownString();
  md.appendMarkdown(`### ${escapeMD(name)}()｜中文速查\n\n`);
  const category=topicMap[name];
  const origin=record.kind==='offline'?'⭐ 用户离线库':record.kind==='cache'?'🤖 AI 缓存':'📚 内置离线库';
  md.appendMarkdown(`*${origin}${category?' · '+escapeMD(category):''}*\n\n`);
  md.appendCodeblock(proto,'c');
  md.appendMarkdown(`\n**作用：** ${escapeMD(brief.summary)}\n\n`);
  md.appendMarkdown(`**参数：**\n\n`);
  for (const p of brief.params) md.appendMarkdown(`- ${escapeMD(p)}\n`);
  md.appendMarkdown(`\n**✅ 成功：** ${escapeMD(brief.success)}\n\n`);
  md.appendMarkdown(`**❌ 失败/特殊：** ${escapeMD(brief.failure)}\n\n`);
  if (settings().detailMode==='full') {
    md.appendMarkdown(`---\n\n**📖 完整解释**\n\n`);
    md.appendMarkdown(`**作用：** ${escapeMD(summary)}\n\n`);
    md.appendMarkdown('**参数：**\n\n');
    for (const p of params) md.appendMarkdown(`- ${escapeMD(p)}\n`);
    md.appendMarkdown(`\n**✅ 成功返回：** ${escapeMD(success)}\n\n`);
    md.appendMarkdown(`**❌ 失败/特殊：** ${escapeMD(failure)}\n\n`);
    md.appendMarkdown(`**提醒：** ${escapeMD(note)}\n\n`);
    if (record.evidence) md.appendMarkdown(`*依据：${escapeMD(record.evidence)}*\n\n`);
  }
  md.appendMarkdown(cmdLink('zhLinuxApiHover.showDetail',name,'📖 查看完整解释'));
  md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.editExplanation',name,'✏️ 编辑解释')}`);
  if (record.kind==='cache') md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.saveOffline',name,'📌 保存到离线库')}`);
  md.appendMarkdown(`　·　${cmdLink('zhLinuxApiHover.refreshFunction',name,'🔄 AI 重新解释 / 提要求')}`);
  md.isTrusted={enabledCommands:['zhLinuxApiHover.showDetail','zhLinuxApiHover.saveOffline','zhLinuxApiHover.refreshFunction','zhLinuxApiHover.editExplanation']};
  return md;
}
function missingMarkdown(name) {
  const md=new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMD(name)}()｜本地未收录**\n\n`);
  md.appendMarkdown('是否属于 Linux/C API 尚未验证；如为自定义函数，请优先看其定义。\n\n');
  md.appendMarkdown(`${cmdLink('zhLinuxApiHover.explainFunction',name,'🤖 AI 查询（可提要求）')}　·　`);
  md.appendMarkdown(`${cmdLink('zhLinuxApiHover.configureApi',name,'⚙️ 配置 AI 接口')}`);
  md.isTrusted={enabledCommands:['zhLinuxApiHover.explainFunction','zhLinuxApiHover.configureApi']};
  return md;
}
function nameAtCursor() {
  const editor=vscode.window.activeTextEditor;
  if (!editor) return '';
  const pos=editor.selection.active;
  const range=editor.document.getWordRangeAtPosition(pos,/[A-Za-z_]\w*/);
  return range?editor.document.getText(range):'';
}
async function chooseName(name,placeholder='输入 C/Linux 函数或宏名称') {
  if (typeof name==='string' && validName(name)) return name;
  const cursorName=nameAtCursor();
  const input=await vscode.window.showInputBox({title:'Linux C 中文速查',prompt:placeholder,value:validName(cursorName)?cursorName:'',validateInput:v=>!validName(v)?'请输入符合 C 标识符规则的函数/宏名称':undefined});
  return input?.trim();
}
function showPanel(name,record) {
  const [proto,summary,params,success,failure,note]=record.entry;
  const panel=vscode.window.createWebviewPanel('zhLinuxApiHoverDetail',`${name}() 中文说明`,vscode.ViewColumn.Beside,{enableScripts:false});
  const origin=record.kind==='offline'?'自定义离线函数库':record.kind==='cache'?'AI 查询缓存':'内置函数库';
  const brief=briefFor(record);
  panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:15px/1.75 system-ui,sans-serif;color:var(--vscode-editor-foreground);padding:20px;max-width:900px;margin:auto}code,pre{font-family:var(--vscode-editor-font-family),monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--vscode-textCodeBlock-background);border-radius:8px}li{margin:4px 0}small{opacity:.7}h1{font-size:1.5em}</style></head><body><h1>${escHTML(name)}()</h1><small>${escHTML(origin)} · ${escHTML(topicMap[name]||'C/Linux')}</small><pre>${escHTML(proto)}</pre><h2>快速理解</h2><p><strong>作用：</strong>${escHTML(brief.summary)}</p><ul>${brief.params.map(p=>`<li>${escHTML(p)}</li>`).join('')}</ul><p><strong>成功：</strong>${escHTML(brief.success)}</p><p><strong>失败：</strong>${escHTML(brief.failure)}</p><hr><h2>完整解释</h2><p><strong>作用：</strong>${escHTML(summary)}</p><h2>参数</h2><ul>${params.map(p=>`<li>${escHTML(p)}</li>`).join('')}</ul><p><strong>✅ 成功返回：</strong>${escHTML(success)}</p><p><strong>❌ 失败/特殊情况：</strong>${escHTML(failure)}</p><p><strong>注意：</strong>${escHTML(note)}</p><small>依据：${escHTML(record.evidence||record.source||'本地整理')}</small></body></html>`;
}
// 手动 AI 查询时提供多行可选要求；自动悬停继续使用默认策略，不弹窗。
// 关闭窗口/取消不发送请求；空白输入等于沿用默认解释流程。
function promptAiInstructions(name,existing,force=false) {
  return new Promise(resolve=>{
    const panel=vscode.window.createWebviewPanel('zhLinuxAiRequirements',
      `AI ${force?'重新解释':'解释'} ${name}()`,vscode.ViewColumn.Beside,{enableScripts:true});
    const nonce=crypto.randomBytes(18).toString('base64');
    const old=existing?.entry;
    const preview=old?`<details><summary>查看当前解释（用作定向修改的参考）</summary>
      <p><b>作用：</b>${escHTML(old[1])}</p><p><b>参数：</b></p><ul>${old[2].map(v=>`<li>${escHTML(v)}</li>`).join('')}</ul>
      <p><b>成功：</b>${escHTML(old[3])}</p><p><b>失败：</b>${escHTML(old[4])}</p><p><b>备注：</b>${escHTML(old[5])}</p></details>`:'';
    panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font:14px/1.65 system-ui,sans-serif;color:var(--vscode-editor-foreground);max-width:850px;margin:auto;padding:22px}h1{font-size:1.4em}textarea{width:100%;box-sizing:border-box;min-height:140px;padding:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:6px;font:inherit;resize:vertical}button{padding:9px 16px;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:15px}.hint{opacity:.82}details{margin-top:24px;border:1px solid var(--vscode-panel-border);padding:12px;border-radius:6px}li{margin-bottom:4px}#count{font-size:.85em;text-align:right;opacity:.8}</style></head><body>
<h1>🤖 ${force?'重新解释':'解释'} ${escHTML(name)}()</h1>
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
  const record=localRecord(name)||app.recent.get(name);
  if (!record) {
    vscode.window.showWarningMessage(`${name}() 暂无中文说明。请先使用 AI 查询，或在离线库中手动新增。`);
    return;
  }
  const original=record.entry;
  const brief=briefFor(record);
  const isBuiltIn=Object.prototype.hasOwnProperty.call(docs,name);
  const panel=vscode.window.createWebviewPanel('zhLinuxApiHoverEdit',`编辑 ${name}() 的中文解释`,vscode.ViewColumn.Beside,{enableScripts:true});
  const nonce=crypto.randomBytes(18).toString('base64');
  const origin=record.kind==='offline'?'用户离线库':record.kind==='cache'?'AI 缓存':'内置函数库';
  const field=(id,label,value,rows=2)=>`<label for="${id}">${escHTML(label)}</label><textarea id="${id}" rows="${rows}" maxlength="6000">${escHTML(value)}</textarea>`;
  panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font:14px/1.55 system-ui,sans-serif;color:var(--vscode-editor-foreground);padding:20px;max-width:860px;margin:auto}
label{display:block;font-weight:600;margin:13px 0 5px}textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;padding:9px;font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder)}h1{font-size:1.45em}h2{margin-top:28px;font-size:1.18em}small,.hint{opacity:.78}.actions{position:sticky;bottom:0;padding:12px 0;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-panel-border)}button{cursor:pointer;padding:9px 18px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:5px}button:disabled{opacity:.55;cursor:wait}#status{margin-left:10px}hr{border:0;border-top:1px solid var(--vscode-panel-border);margin-top:24px}
</style></head><body>
<h1>✏️ 编辑 ${escHTML(name)}() 中文解释</h1><p class="hint">原始来源：${escHTML(origin)}。点击保存后，新内容覆盖悬停显示；${isBuiltIn?'内置原文不会被修改，可通过删除用户离线覆盖记录恢复。':'历史 AI 缓存不会被修改。'}所有修改仅存储在本机 VS Code 的用户离线库。</p>
<h2>① 简洁版（默认悬停内容）</h2>
${field('b_summary','作用（简洁）',brief.summary,2)}
${field('b_params','参数（每行一项）',brief.params.join('\n'),5)}
${field('b_success','成功返回值（简洁）',brief.success,2)}
${field('b_failure','失败 / 特殊返回值（简洁）',brief.failure,2)}
<hr><h2>② 详细版（“查看完整解释”）</h2>
${field('proto','函数原型 / 宏用法',original[0],2)}
${field('summary','完整作用说明',original[1],4)}
${field('params','完整参数（每行一项）',original[2].join('\n'),6)}
${field('success','成功返回值详细说明',original[3],3)}
${field('failure','失败和特殊情况详细说明',original[4],3)}
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
      await app.store.putOffline(name,entry,'用户手动编辑',record.evidence||record.source||'',compact);
      app.recent.delete(name);
      await panel.webview.postMessage({type:'saveResult',ok:true});
      vscode.window.showInformationMessage(`${name}() 中文解释已保存到用户离线库`);
    }catch(e){await panel.webview.postMessage({type:'saveResult',ok:false,error:e.message});}
  });
  panel.onDidDispose?.(()=>handler.dispose());
}
async function setApiKey() {
  const current=await apiConfigStatus();
  const choice=await vscode.window.showQuickPick(['设置 / 更新 API Key',...(current.keyPresent?['删除已有 API Key']:[])],{title:'管理 AI API Key',placeHolder:current.keyPresent?'当前状态：已保存密钥':'当前状态：尚未保存密钥'});
  if (!choice) return;
  if (choice.startsWith('删除')) {
    await app.ctx.secrets.delete('aiApiKey');
    vscode.window.showInformationMessage('已删除本扩展保存的 API Key');
    return;
  }
  const key=await vscode.window.showInputBox({title:'输入 API Key',password:true,ignoreFocusOut:true,placeHolder:'sk-...（不会写入 settings.json）',validateInput:v=>v.trim().length===0?'密钥不能为空':undefined});
  if (key===undefined) return;
  try {
    await app.ctx.secrets.store('aiApiKey',key.trim());
    const confirm=await app.ctx.secrets.get('aiApiKey');
    if (!confirm || confirm!==key.trim()) throw new Error('保存后无法从 SecretStorage 读取到相同的密钥');
    vscode.window.showInformationMessage('API Key 已安全保存并验证可读；不会显示或上传密钥');
  }catch(e){
    vscode.window.showErrorMessage('API Key 保存失败：'+e.message+'。请检查 VS Code 密钥存储环境。');
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
    const key=await vscode.window.showInputBox({title:'输入 API Key',password:true,ignoreFocusOut:true,placeHolder:'sk-...',validateInput:v=>v.trim()?undefined:'密钥不能为空'});
    if (key===undefined) {vscode.window.showWarningMessage('密钥输入已取消，AI 配置可能仍不完整。');return;}
    try {await app.ctx.secrets.store('aiApiKey',key.trim());}
    catch(e){vscode.window.showErrorMessage('无法保存 API Key：'+e.message);return;}
  }
  const result=await apiConfigStatus();
  if (result.ready) vscode.window.showInformationMessage('AI 配置完整：API 地址、模型和密钥均已读到（尚未验证 API 连通性）。');
  else vscode.window.showWarningMessage('AI 配置仍不完整：'+[...result.missing,...(result.storageError?[result.storageError]:[])].join('、'));
}
const pending=new Map();
async function queryAi(name,{force=false,quiet=false,signal,instructions=''}={}) {
  if (!validName(name)) throw new Error('请输入有效的函数/宏名称');
  if (typeof instructions!=='string' || instructions.length>2000)throw new Error('补充要求最多 2000 字');
  const conf=settings();
  const key=cacheKey(name,conf.baseUrl,conf.model);
  const hasInstructions=Boolean(instructions.trim());
  // 带补充要求的请求必须绕开已有词条和缓存，否则 AI 根本不会收到要求。
  if (!force && !hasInstructions) {
    const hit=localRecord(name);
    if (hit) return hit;
  }
  const previous=hasInstructions ? (app.recent.get(name)||localRecord(name)) : null;
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
    const {entry,brief,evidence}=await explain(name,{baseUrl:conf.baseUrl,model:conf.model,timeoutMs:conf.timeoutMs,retryCount:conf.retryCount,proxyUrl:conf.proxyUrl},secret,
      {signal,instructions,previous,onRetry:info=>app.output.appendLine(`${name}(): 第 ${info.attempt} 次请求暂时失败（${info.reason}），正在重试`) });
    if (signal?.aborted) throw new Error('已取消');
    const record={entry,...(brief?{brief}:{}),source:`AI:${name}`,evidence,kind:'cache',updatedAt:new Date().toISOString()};
    app.recent.set(name,record);
    if (conf.cacheEnabled) await app.store.putCache(key,entry,`AI:${name}`,evidence,brief||null);
    if (conf.saveMode==='auto' && !Object.prototype.hasOwnProperty.call(docs,name) && !app.store.offline[name]) {
      await app.store.putOffline(name,entry,'AI 自动保存（未人工审核）',evidence,brief||null);
      return {...record,kind:'offline'};
    }
    return record;
  })();
  pending.set(inflightKey,work);
  try{return await work;}finally{pending.delete(inflightKey);}
}
async function explainCommand(arg, force=false) {
  const name=await chooseName(arg); if (!name) return;
  // 仅在主动查询时展示要求输入。空要求沿用默认行为；取消则不请求。
  const previous=app.recent.get(name)||localRecord(name);
  const instructions=await promptAiInstructions(name,previous,force);
  if(instructions===undefined)return;
  try {
    let result;
    await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`查询 ${name}() 的中文函数说明`,cancellable:false},async()=>{
      result=await queryAi(name,{force,instructions});
    });
    showPanel(name,result);
    if (result.kind==='cache' && (force||instructions || !previous)) {
      const action=await vscode.window.showInformationMessage(`${name}() 的 AI 解释已生成${settings().cacheEnabled?'并缓存':''}。${previous?'原离线词条尚未被覆盖。':'可保存为永久离线词条。'}`, '保存到永久离线库');
      if (action) await saveOffline(name);
    }
  } catch(e) {if (!/AI 配置缺失|已取消/.test(e.message)) {
    app.output.appendLine(`${name}(): ${e.message}`);
    const action=await vscode.window.showErrorMessage(`中文函数查询失败：${e.message}`,'查看网络日志','测试 API 连接');
    if(action==='查看网络日志')app.output.show(true);
    if(action==='测试 API 连接')await testAiNetwork();
  }}
}
async function saveOffline(arg) {
  const name=await chooseName(arg,'输入要从 AI 缓存保存的函数名称'); if (!name) return;
  const cfgAi=settings();
  const hit=cfgAi.baseUrl && cfgAi.model? app.store.cache[cacheKey(name,cfgAi.baseUrl,cfgAi.model)]:null;
  let rec=app.recent.get(name) || hit || app.store.offline[name];
  if (!rec) {
    vscode.window.showWarningMessage(`${name}() 尚无可保存的 AI 缓存，请先使用“AI 查询函数”。`);
    return;
  }
  if (app.store.offline[name] || Object.prototype.hasOwnProperty.call(docs,name)) {
    const result=await vscode.window.showWarningMessage(`${name}() 已存在离线说明。要用当前 AI 缓存覆盖自定义离线记录吗？`,{modal:true},'确认覆盖');
    if (result!=='确认覆盖') return;
  }
  await app.store.putOffline(name,rec.entry,'AI 结果 · 用户确认保存',rec.evidence||'',rec.brief||null);
  vscode.window.showInformationMessage(`已保存 ${name}() 到永久离线函数与宏库，断网也可查看`);
}
async function searchFunctions() {
  const names=new Set([...Object.keys(docs),...Object.keys(app.store.offline)]);
  const items=[{label:'$(sparkle)  AI 查询未收录的函数',name:null,description:'输入函数名，按需使用 AI'},
    ...[...names].sort().map(name=>({label:`${name}()`,name,description:app.store.offline[name]?'自定义离线库':topicMap[name]||'C/Linux API',detail:(app.store.offline[name]?.entry||docs[name])[1]}))];
  const item=await vscode.window.showQuickPick(items,{title:`中文函数速查（${names.size} 个永久离线条目）`,matchOnDescription:true,matchOnDetail:true});
  if (!item) return;
  if (item.name) showPanel(item.name,localRecord(item.name));
  else await explainCommand();
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
  await app.store.putOffline(name,entry,'用户手工维护','用户编辑');
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
    case 'update': {const n=await vscode.window.showQuickPick([...new Set([...Object.keys(docs),...Object.keys(app.store.offline)])].sort(),{title:'选择要编辑的函数（包括内置库）'});if(n)await editExplanation(n);break;}
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
    searchFunctions, explainFunction:arg=>explainCommand(arg,false),refreshFunction:arg=>explainCommand(arg,true),
    saveOffline,manageOffline,editExplanation,configureApi,setApiKey,checkAiConfig,testAiNetwork,clearCache,
    showDetail:async arg=>{const name=await chooseName(arg);if(!name)return;const rec=localRecord(name)||app.recent.get(name);if(rec)showPanel(name,rec);else vscode.window.showWarningMessage('未找到本地说明，请先进行 AI 查询。');},reloadOffline:async()=>{await store.reloadOffline();vscode.window.showInformationMessage('离线库已经重新载入');},exportOffline,importOffline
  };
  for (const [name,fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`zhLinuxApiHover.${name}`,fn));
  context.subscriptions.push(vscode.languages.registerHoverProvider([{language:'c'},{language:'cpp'}],{
    async provideHover(document,position,token){
      const range=document.getWordRangeAtPosition(position,/[A-Za-z_]\w*/);
      if (!range) return;
      const name=document.getText(range);
      if (!validName(name)) return;
      const rest=document.lineAt(range.end.line).text.slice(range.end.character);
      if (!/^\s*\(/.test(rest)) return;
      const cached=localRecord(name);
      if (cached) return new vscode.Hover(markdownFor(name,cached),range);
      if (settings().hoverMode!=='auto') return new vscode.Hover(missingMarkdown(name),range);
      // 用户明确启用 auto 才调用网络，等待片刻减少鼠标路过误触。
      await new Promise(resolve=>setTimeout(resolve,420));
      if (token?.isCancellationRequested) return;
      const abort=new AbortController();
      const disposable=token?.onCancellationRequested?.(()=>abort.abort());
      try {
        const item=await queryAi(name,{quiet:true,signal:abort.signal});
        return token?.isCancellationRequested?undefined:new vscode.Hover(markdownFor(name,item),range);
      }catch(e){
        if (token?.isCancellationRequested) return;
        const md=missingMarkdown(name);
        md.appendMarkdown(`\n\n*自动查询失败：${escapeMD(e.message)}*`);
        return new vscode.Hover(md,range);
      }finally{disposable?.dispose();}
    }
  }));
}
function deactivate() {}
module.exports={activate,deactivate, /* testable pure helpers */ markdownFor,missingMarkdown,localRecord,settings,queryAi,promptAiInstructions};
