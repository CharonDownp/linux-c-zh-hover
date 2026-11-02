'use strict';
const vscode = require('vscode');
const SCHEMA = 1;
const MAX_ENTRIES = 4000;
const MAX_FIELD = 6000;
function validateBrief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys=['summary','success','failure'];
  if (!keys.every(k=>typeof raw[k]==='string' && raw[k].length<=MAX_FIELD)) return null;
  if (!Array.isArray(raw.params) || raw.params.length>20 || !raw.params.every(v=>typeof v==='string' && v.length<=MAX_FIELD)) return null;
  return {summary:raw.summary,params:raw.params.slice(),success:raw.success,failure:raw.failure};
}
function validName(name) { return typeof name === 'string' && /^[A-Za-z_]\w{0,127}$/.test(name); }
function validateEntry(raw) {
  if (!Array.isArray(raw) || raw.length !== 6 ||
      typeof raw[0] !== 'string' || typeof raw[1] !== 'string' || !Array.isArray(raw[2]) ||
      raw[2].length > 20 || !raw[2].every(p => typeof p === 'string' && p.length <= MAX_FIELD) ||
      ![3,4,5].every(i => typeof raw[i] === 'string' && raw[i].length <= MAX_FIELD) ||
      raw[0].length > MAX_FIELD || raw[1].length > MAX_FIELD) return null;
  return raw.map((x,i)=> i===2 ? x.slice() : x);
}
function safeRecord(obj) {
  const out = Object.create(null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key,value] of Object.entries(obj).slice(0, MAX_ENTRIES)) {
    if (!(validName(key) || /^[0-9a-f]{64}$/.test(key)) || !value || typeof value !== 'object') continue;
    const entry = validateEntry(value.entry);
    if (entry) out[key] = {
      entry, ...(validateBrief(value.brief)?{brief:validateBrief(value.brief)}:{}), source: String(value.source || '用户保存').slice(0,120),
      updatedAt: String(value.updatedAt || '').slice(0,60),
      evidence: String(value.evidence || '').slice(0,160),
      ...(typeof value.symbolKind==='string' && /^(struct|union|enum|typedef|macro|member|variable)$/.test(value.symbolKind)?{symbolKind:value.symbolKind}:{})
    };
  }
  return out;
}
class Storage {
  constructor(ctx) {
    this.ctx=ctx;
    this.cache=Object.create(null);
    this.offline=Object.create(null);
    this.writing=Promise.resolve();
  }
  path(name) { return vscode.Uri.joinPath(this.ctx.globalStorageUri, name); }
  async read(name) {
    try {const data=await vscode.workspace.fs.readFile(this.path(name)); const json=JSON.parse(Buffer.from(data).toString('utf8'));return safeRecord(json.entries);} catch(e) {
      if (e?.code === 'FileNotFound' || e?.code === 'ENOENT' || /not found/i.test(e?.message||'')) return Object.create(null);
      vscode.window.showWarningMessage(`中文速查：读取 ${name} 失败，未覆盖原文件：${e.message}`);
      throw e;
    }
  }
  async init() {
    await vscode.workspace.fs.createDirectory(this.ctx.globalStorageUri);
    this.offline=await this.read('offline-library.json');
    this.cache=await this.read('ai-cache.json');
  }
  async reloadOffline() {this.offline=await this.read('offline-library.json');}
  save(file,data) {
    const task = async () => {
      const uri=this.path(file), tmp=this.path(`${file}.${process.pid}.tmp`);
      const bytes=Buffer.from(JSON.stringify({schemaVersion:SCHEMA,entries:data},null,2),'utf8');
      await vscode.workspace.fs.writeFile(tmp,bytes);
      await vscode.workspace.fs.rename(tmp,uri,{overwrite:true});
    };
    const result=this.writing.then(task);
    this.writing=result.catch(()=>{});
    return result;
  }
  async putOffline(name,entry,source,evidence='',brief=null,symbolKind=null) {
    if (!validName(name) || !validateEntry(entry)) throw new Error('函数名或说明格式无效');
    if (brief!==null && !validateBrief(brief)) throw new Error('简洁版说明格式无效');
    this.offline[name]={entry:validateEntry(entry), ...(brief?{brief:validateBrief(brief)}:{}), ...(symbolKind?{symbolKind}:{}),source,evidence,updatedAt:new Date().toISOString()};
    await this.save('offline-library.json',this.offline);
  }
  async removeOffline(name) { delete this.offline[name]; await this.save('offline-library.json',this.offline); }
  async putCache(key,entry,source,evidence='',brief=null,symbolKind=null) {
    // cache key 使用 64 位十六进制摘要，避免外部输入成为属性名。
    if (!/^[0-9a-f]{64}$/.test(key) || !validateEntry(entry)) throw new Error('缓存格式无效');
    if(brief!==null && !validateBrief(brief)) throw new Error('缓存简洁版说明格式无效');
    this.cache[key]={entry:validateEntry(entry),...(brief?{brief:validateBrief(brief)}:{}),...(symbolKind?{symbolKind}:{}),source,evidence,updatedAt:new Date().toISOString()};
    const keys=Object.keys(this.cache);
    if (keys.length>350) keys.sort((a,b)=>this.cache[a].updatedAt.localeCompare(this.cache[b].updatedAt)).slice(0,keys.length-350).forEach(k=>delete this.cache[k]);
    await this.save('ai-cache.json',this.cache);
  }
  async clearCache() {this.cache=Object.create(null);await this.save('ai-cache.json',this.cache);}
}
module.exports={Storage,validateEntry,validateBrief,validName,safeRecord};
