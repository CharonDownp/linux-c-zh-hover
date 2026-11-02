'use strict';
// Apply strictly field-scoped AI revisions instead of allowing a regeneration
// to silently replace fields the user already likes.
const {validateEntry,validateBrief}=require('./storage');
const {briefOf,conciseParams}=require('./brief');
const FIELDS={prototype:0,summary:1,params:2,success:3,failure:4,note:5};
const BRIEF_FIELDS=new Set(['summary','params','success','failure']);
function readJson(raw) {
  if(typeof raw!=='string')throw new Error('AI 返回内容不是文字');
  const s=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(s);}catch{throw new Error('AI 没有返回可解析的 JSON，请尝试重新解释');}
}
function editParams(target,updates,label) {
  if(updates===undefined)return false;
  if(!Array.isArray(updates) || updates.length>20)throw new Error(`${label} 格式无效`);
  for(const item of updates) {
    if(!item || !Number.isInteger(item.index) || item.index<0 || item.index>=target.length ||
      typeof item.text!=='string' || !item.text.trim() || item.text.length>6000) throw new Error(`${label} 的下标或内容无效`);
    target[item.index]=item.text.trim();
  }
  return updates.length>0;
}
function mergeRevision(name, previous, response) {
  const obj=typeof response==='string'?readJson(response):response;
  if(!obj || obj.known===false || (obj.name && obj.name!==name))throw new Error('AI 返回的函数名不匹配，或无法确认函数身份');
  if(!previous || !validateEntry(previous.entry))throw new Error('没有可供定向修改的原始解释');
  if(obj.changes!==undefined && (typeof obj.changes!=='object' || obj.changes===null || Array.isArray(obj.changes)))throw new Error('AI 未按要求返回局部修改格式');
  const changes=obj.changes||{}, briefChanges=obj.briefChanges||{};
  if(typeof briefChanges!=='object' || Array.isArray(briefChanges))throw new Error('简洁版修改格式无效');
  if(Object.keys(changes).some(k=>!(k in FIELDS)) || Object.keys(briefChanges).some(k=>!BRIEF_FIELDS.has(k)))throw new Error('AI 返回了不支持的修改字段');
  if(changes.params!==undefined && obj.paramEdits!==undefined)throw new Error('不能同时替换全部参数并单独修改参数');
  if(briefChanges.params!==undefined && obj.briefParamEdits!==undefined)throw new Error('不能同时替换简洁参数并单独修改参数');
  const entry=previous.entry.map((v,i)=>i===2?v.slice():v);
  let touched=false;
  const changedFields=new Set();
  for(const [field,value] of Object.entries(changes)) {
    if(field==='params') {
      if(!Array.isArray(value) || value.length>20 || !value.every(p=>typeof p==='string'&&p.length<=6000))throw new Error('AI 修改的参数列表不合法');
      entry[2]=value.slice();
    } else {
      if(typeof value!=='string' || value.length>6000 || (field!=='note' && !value.trim()))throw new Error(`${field} 修改内容不合法`);
      entry[FIELDS[field]]=value;
    }
    changedFields.add(field);touched=true;
  }
  if(editParams(entry[2],obj.paramEdits,'详细版参数修改')){touched=true;changedFields.add('params');}
  const before=previous.brief||briefOf(previous.entry);
  const brief={summary:before.summary,params:before.params.slice(),success:before.success,failure:before.failure};
  const newlyBrief=briefOf(entry);
  for(const f of ['summary','params','success','failure'])if(changedFields.has(f))brief[f]=newlyBrief[f];
  // When only one detail parameter changes, preserve every other compact
  // parameter, including content previously edited by the user.
  if(obj.paramEdits && !changes.params && !('params' in briefChanges)){
    brief.params=before.params.slice();
    for(const item of obj.paramEdits){
      if(item.index<brief.params.length && item.index<4)brief.params[item.index]=conciseParams([entry[2][item.index]])[0];
    }
  }
  for(const [field,value] of Object.entries(briefChanges)){
    if(field==='params') {
      if(!Array.isArray(value)||value.length>20||!value.every(s=>typeof s==='string'&&s.length<=6000))throw new Error('简洁参数修改内容不合法');
      brief.params=value.slice();
    } else {
      if(typeof value!=='string'||!value.trim()||value.length>6000)throw new Error('简洁版修改内容不合法');
      brief[field]=value;
    }
    touched=true;
  }
  if(editParams(brief.params,obj.briefParamEdits,'简洁版参数修改'))touched=true;
  if(!touched)throw new Error('AI 没有提交任何改动，可以更明确地描述需要修改的部分');
  if(!validateEntry(entry)||!validateBrief(brief))throw new Error('局部修改后的说明格式不合法，未保存');
  return {entry,brief};
}
module.exports={readJson,mergeRevision};
