'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const Module=require('node:module');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'zh-api-hover-test-'));
let hoverFn;
let commands={};
let lastPanel=null;
let nextPromptText='';
let nextSecretInput='';
let secretInputMethod='enter';
let lastInputBox=null;
const promptLog=[];
const settingsObj={ 'ai.baseUrl':'','ai.model':'','ai.hoverMode':'manual','ai.saveMode':'manual','ai.cacheEnabled':true,'ai.timeoutMs':4000 };
const secret={value:''};
class MarkdownString {
  constructor(){this.value='';this.isTrusted=false;}
  appendMarkdown(s){this.value+=s;}
  appendCodeblock(s,lang){this.value+='\n```'+lang+'\n'+s+'\n```\n';}
}
const vscode={
  MarkdownString,ThemeIcon:class{constructor(id){this.id=id;}},Hover:class{constructor(contents,range){this.contents=contents;this.range=range;}},
  Uri:{joinPath:(base,name)=>path.join(base,name),file:s=>s},
  ProgressLocation:{Notification:15},ViewColumn:{Beside:2},ConfigurationTarget:{Global:1},
  workspace:{fs:{
    createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),
    readFile:async p=>fs.promises.readFile(p),
    writeFile:async(p,data)=>fs.promises.writeFile(p,data),
    rename:async(a,b)=>fs.promises.rename(a,b),
  },getConfiguration:()=>({get:(key,def)=>settingsObj[key]??def,update:async(key,val)=>settingsObj[key]=val})},
  languages:{registerHoverProvider:(sel,provider)=>{hoverFn=provider.provideHover;return {dispose(){}};}},
  commands:{registerCommand:(name,fn)=>{commands[name]=fn;return {dispose(){}};}},
  window:{
    notices:[],showWarningMessage:async()=>undefined,showErrorMessage:async s=>{throw new Error(s);},
    showInformationMessage:async()=>undefined,showInputBox:async()=>undefined,showQuickPick:async()=>undefined,
    withProgress:async(options,action)=>action(),
    createInputBox:()=>{
      const handlers={accept:[],button:[],change:[],hide:[]};
      const listener=type=>fn=>{handlers[type].push(fn);return {dispose(){}};};
      const input={value:'',buttons:[],password:false,
        onDidAccept:listener('accept'),onDidTriggerButton:listener('button'),
        onDidChangeValue:listener('change'),onDidHide:listener('hide'),
        hide(){for(const fn of handlers.hide)fn();},dispose(){},
        show(){
          queueMicrotask(()=>{
            input.value=nextSecretInput;nextSecretInput='';
            for(const fn of handlers.change)fn(input.value);
            if(secretInputMethod==='button'){for(const fn of handlers.button)fn(input.buttons[0]);}
            else if(secretInputMethod==='cancel')input.hide();
            else for(const fn of handlers.accept)fn();
          });
        }};
      lastInputBox=input;
      return input;
    },
    createWebviewPanel:(viewType)=>{
      let onDispose=()=>{};
      const panel={viewType,webview:{html:'',postMessage:async message=>{panel.lastResponse=message;},onDidReceiveMessage:callback=>{panel.handleMessage=callback;return {dispose(){}};}},onDidDispose:callback=>{onDispose=callback;},dispose:()=>onDispose()};
      lastPanel=panel;
      if(viewType==='zhLinuxAiRequirements') {
        promptLog.push(panel);
        const value=nextPromptText;nextPromptText='';
        queueMicrotask(()=>panel.handleMessage?.(value===null?{type:'cancel'}:{type:'run',instructions:value}));
      }
      return panel;
    },
    createOutputChannel:()=>({appendLine:()=>{},show:()=>{},dispose:()=>{}})
  }
};
const origLoad=Module._load;
Module._load=function(request,parent,isMain){ if (request==='vscode') return vscode;return origLoad.apply(this,arguments);};
const ai=require('../lib/ai');
const {Storage}=require('../lib/storage');
const extension=require('../extension');
Module._load=origLoad;
const ctx=()=>({globalStorageUri:tmp,subscriptions:[],secrets:{get:async()=>secret.value,store:async(_,v)=>{secret.value=v;},delete:async()=>secret.value=''}});
const tests=[];
function test(name,fn){tests.push({name,fn});}
function localServer() {
  const state={count:0,last:null,auth:null};
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      state.count++;
      state.last=JSON.parse(body);
      state.auth=req.headers.authorization;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'new_api',known:true,prototype:'int new_api(int arg);',summary:'示例测试函数',params:['arg：传入整数'],success:'成功返回整数结果',failure:'失败返回 -1',note:'本机 man 无此函数，属于测试生成内容'})}}]}));
    });
  });
  return {state,server};
}
test('默认手动模式不会自动发起网络请求，内置 245 个函数可悬停',async()=>{
  await extension.activate(ctx());
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:8}}),getText:()=> 'shm_open',lineAt:()=>({text:'shm_open("/xxx",O_RDWR,0664);'})};
  const result=await hoverFn(doc,{},{});
  assert.match(result.contents.value,/文件描述符/);
  assert.match(result.contents.value,/✅ 成功/);
  assert.match(result.contents.value,/查看完整解释/);
  assert.doesNotMatch(result.contents.value,/提醒：/);
  assert.equal(typeof commands['zhLinuxApiHover.saveOffline'],'function');
  assert.equal(settingsObj['ai.hoverMode'],'manual');
});
test('未知函数悬停提供点击查询入口，不发请求',async()=>{
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:7}}),getText:()=> 'new_api',lineAt:()=>({text:'new_api(2);'})};
  const result=await hoverFn(doc,{},{});
  assert.match(result.contents.value,/本地未收录/);
  assert.match(result.contents.value,/command:zhLinuxApiHover.explainFunction/);
});
test('API URL 检查：公网 HTTP 禁止，本机 HTTP 允许',async()=>{
  assert.throws(()=>ai.endpointFrom('http://example.com/v1'),/HTTPS/);
  assert.equal(ai.endpointFrom('http://127.0.0.1:3333/v1/').pathname,'/v1/chat/completions');
  assert.equal(ai.endpointFrom('https://example.com/v1/chat/completions').pathname,'/v1/chat/completions');
});
test('本地 HTTP 模拟模型请求，校验 POST 内容和密钥',async()=>{
  const {server,state}=localServer();
  await new Promise(res=>server.listen(0,'127.0.0.1',res));
  try{
    const port=server.address().port;
    const text=await ai.callCompatibleApi({baseUrl:`http://127.0.0.1:${port}/v1`,model:'demo',key:'test-secret',messages:[{role:'user',content:'test'}]});
    const entry=ai.parseAiEntry(text,'new_api');
    assert.equal(entry[3],'成功返回整数结果');
    assert.equal(state.last.model,'demo');
    assert.equal(state.auth,'Bearer test-secret');
    assert.equal(state.count,1);
  }finally{server.close();}
});
test('AI 缓存可重启加载，一键升级为永久离线库，导出仅包含离线内容',async()=>{
  const storage=new Storage(ctx()); await storage.init();
  const entry=['int new_api(int arg);','测试说明',['arg：参数'],'成功 0','失败 -1','AI 尚未核验'];
  const key=ai.cacheKey('new_api','https://example.com/v1','demo');
  await storage.putCache(key,entry,'AI:new_api','仅 AI 推断');
  const afterRestart=new Storage(ctx()); await afterRestart.init();
  assert.equal(afterRestart.cache[key].entry[1],'测试说明');
  await afterRestart.putOffline('new_api',entry,'用户确认','仅 AI 推断');
  const again=new Storage(ctx());await again.init();
  assert.equal(again.offline.new_api.entry[3],'成功 0');
  await again.clearCache();
  const third=new Storage(ctx());await third.init();
  assert.equal(Object.keys(third.cache).length,0);
  assert.ok(third.offline.new_api);
  assert.ok(!JSON.stringify(third.offline).includes('test-secret'));
});
test('完整集成：点击 AI 查询 → 写入缓存 → 点击保存 → 离线悬停',async()=>{
  const {server,state}=localServer();
  await new Promise(res=>server.listen(0,'127.0.0.1',res));
  try {
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='test-model';
    secret.value='local-only-secret';
    await commands['zhLinuxApiHover.explainFunction']('new_api');
    assert.equal(state.count,1);
    await commands['zhLinuxApiHover.saveOffline']('new_api');
    const persisted=JSON.parse(fs.readFileSync(path.join(tmp,'offline-library.json'),'utf8'));
    assert.equal(persisted.entries.new_api.entry[3],'成功返回整数结果');
    assert.ok(!JSON.stringify(persisted).includes('local-only-secret'));
    const doc={getWordRangeAtPosition:()=>({end:{line:0,character:7}}),getText:()=> 'new_api',lineAt:()=>({text:'new_api(2);'})};
    const result=await hoverFn(doc,{},{});
    assert.match(result.contents.value,/用户离线库/);
    await commands['zhLinuxApiHover.explainFunction']('new_api');
    assert.equal(state.count,1, '重复查看离线词条不再调用 API');
  } finally {server.close();}
});
test('配置安全：不存在误将密钥写入配置对象的路径',async()=>{
  assert.ok(!Object.keys(settingsObj).some(k=>/key|secret/i.test(k)));
  assert.throws(()=>ai.parseAiEntry(JSON.stringify({known:false}),'x'),/无法确认/);
});
test('配置状态明确指出缺失项，而不是笼统报全部缺失',async()=>{
  settingsObj['ai.baseUrl']='https://example.com/v1';
  settingsObj['ai.model']='demo';
  secret.value='';
  await assert.rejects(extension.queryAi('totally_new_func',{quiet:true}),/API Key/);
  await assert.rejects(extension.queryAi('totally_new_func',{quiet:true}),/AI 配置缺失/);
});
test('配置向导要求新用户输入密钥，并验证 SecretStorage 可读',async()=>{
  settingsObj['ai.baseUrl']='';
  settingsObj['ai.model']='';
  secret.value='';
  const prevBox=vscode.window.showInputBox;
  const prevPick=vscode.window.showQuickPick;
  let seenOptions=[];
  try {
    const inputs=['https://example.com/v1','demo-model'];
    nextSecretInput='safe-key-123';secretInputMethod='button';
    vscode.window.showInputBox=async()=>inputs.shift();
    vscode.window.showQuickPick=async choices=>{seenOptions=choices;return choices[0];};
    await commands['zhLinuxApiHover.configureApi']();
    assert.equal(settingsObj['ai.baseUrl'],'https://example.com/v1');
    assert.equal(settingsObj['ai.model'],'demo-model');
    assert.equal(secret.value,'safe-key-123');
    assert.ok(!seenOptions.some(x=>/保留已保存/.test(x)), '无密钥时不应出现跳过选项');
  } finally {
    vscode.window.showInputBox=prevBox;
    vscode.window.showQuickPick=prevPick;
  }
});

test('独立密钥更新：点击 ✓ 保存；支持 Enter；取消时保留旧值',async()=>{
  secret.value='old-key';
  nextSecretInput='new-key';secretInputMethod='button';
  await commands['zhLinuxApiHover.setApiKey']();
  assert.equal(secret.value,'new-key');
  assert.equal(lastInputBox.password,true);
  assert.equal(lastInputBox.buttons[0].tooltip.includes('保存 API Key'),true);
  nextSecretInput='via-enter';secretInputMethod='enter';
  await commands['zhLinuxApiHover.setApiKey']();
  assert.equal(secret.value,'via-enter');
  nextSecretInput='ignored';secretInputMethod='cancel';
  await commands['zhLinuxApiHover.setApiKey']();
  assert.equal(secret.value,'via-enter');
});
test('真实模型 POST 诊断，不同于匿名 GET，携带保存的 Bearer 密钥',async()=>{
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'POST');
    assert.equal(req.headers.authorization,'Bearer test-auth-key');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const oldShow=vscode.window.showInformationMessage;
  try{
    secret.value='test-auth-key';
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='test-model';
    vscode.window.showInformationMessage=async(msg,opts,...buttons)=>buttons.includes('开始测试')?'开始测试':undefined;
    await commands['zhLinuxApiHover.testAiAuthentication']();
  }finally{
    vscode.window.showInformationMessage=oldShow;
    await new Promise(resolve=>server.close(resolve));
  }
});
test('服务端 401 显示安全的具体原因，不泄露密钥',async()=>{
  const key='sk-not-for-logs-0123456789';
  const server=http.createServer((req,res)=>{
    req.resume();res.statusCode=401;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({error:{message:`Expired access token ${key}, please renew`}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=server.address().port;
    await assert.rejects(ai.callCompatibleApi({baseUrl:`http://127.0.0.1:${port}/v1`,model:'model',key,messages:[{role:'user',content:'ok'}],retryCount:0}),error=>{
      assert.match(error.message,/401/);
      assert.match(error.message,/Expired access token/);
      assert.doesNotMatch(error.message,/sk-not-for-logs/);
      return true;
    });
    assert.throws(()=>ai.endpointFrom('https://example.com/v1/models'),/不要填/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('新网络自检：非付费 GET、不携带密钥、405 也确认 HTTP 可达',async()=>{
  let seenMethod=null,seenAuthorization=null;
  const server=http.createServer((req,res)=>{
    seenMethod=req.method; seenAuthorization=req.headers.authorization;
    res.statusCode=405;res.end('Method Not Allowed');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const result=await ai.probeApiEndpoint(`http://127.0.0.1:${server.address().port}/v1`,3000);
    assert.equal(result.statusCode,405);
    assert.equal(seenMethod,'GET');
    assert.equal(seenAuthorization,undefined);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('新网络自检：无响应时提供明确超时信息',async()=>{
  const server=http.createServer(()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(ai.probeApiEndpoint(`http://127.0.0.1:${server.address().port}/v1`,100),/超时/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('新版配置：超时默认 90 秒，提供网络测试命令',async()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.contributes.configuration.properties['zhLinuxApiHover.ai.timeoutMs'].default,90000);
  assert.equal(typeof commands['zhLinuxApiHover.testAiNetwork'],'function');
});
test('默认速览不丢失完整说明：点击查看详细、老缓存无需重新生成',async()=>{
  const long=['int clock_gettime(clockid_t clockid, struct timespec *tp);',
    '读取指定时钟的当前时间，并写入 tp 指向的 struct timespec 结构。',
    ['clockid：要读取的时钟标识；CLOCK_REALTIME 是墙上时间；CLOCK_MONOTONIC 是单调时钟',
    'tp：指向可写的 struct timespec 结构，用于接收时间；tv_sec 为秒数，tv_nsec 为纳秒字段'],
    '返回 0，并将时间写入 *tp；返回值本身不是时间。连续读取单调时钟可能相同。',
    '返回 -1，并设置 errno；错误包括 EFAULT、EINVAL 等。',
    '包含 <time.h>，某些环境需要 feature test macro。'];
  const {briefOf}=require('../lib/brief');
  const brief=briefOf(long);
  assert.equal(brief.summary,'读取指定时钟的当前时间，并写入 tp 指向的 struct timespec 结构');
  assert.equal(brief.params[0],'clockid：要读取的时钟标识');
  assert.match(brief.success,/返回 0/);
  assert.match(brief.failure,/返回 -1/);
  const store=new Storage(ctx());await store.init();
  await store.putOffline('clock_gettime',long,'测试','本机手册');
  // activate loads existing offline library without migration
  await extension.activate(ctx());
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:13}}),getText:()=> 'clock_gettime',lineAt:()=>({text:'clock_gettime(CLOCK_REALTIME, &ts);'})};
  let hover=await hoverFn(doc,{},{});
  assert.match(hover.contents.value,/查看完整解释/);
  assert.doesNotMatch(hover.contents.value,/CLOCK_MONOTONIC/);
  await commands['zhLinuxApiHover.showDetail']('clock_gettime');
  assert.match(lastPanel.webview.html,/CLOCK_MONOTONIC/);
  assert.match(lastPanel.webview.html,/快速理解/);
  assert.match(lastPanel.webview.html,/完整解释/);
  settingsObj['hover.detailMode']='full';
  hover=await hoverFn(doc,{},{});
  assert.match(hover.contents.value,/完整解释/);
  assert.match(hover.contents.value,/CLOCK\\_MONOTONIC/);
  settingsObj['hover.detailMode']='compact';
});
test('临时 HTTP 503 后自动重试一次，不重试 401',async()=>{
  let calls=0;
  const server=http.createServer((req,res)=>{
    calls++;
    req.resume();req.on('end',()=>{
      if(calls===1){res.statusCode=503;res.end('busy');return;}
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:'{"known":true}'}}]}));
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    let retries=[];
    const result=await ai.callCompatibleApi({baseUrl,model:'demo',key:'xxx',messages:[],retryCount:1,onRetry:x=>retries.push(x)});
    assert.equal(result,'{"known":true}');assert.equal(calls,2);assert.equal(retries.length,1);
  }finally{await new Promise(ok=>server.close(ok));}
  let denied=0;
  const forbidden=http.createServer((req,res)=>{denied++;req.resume();res.statusCode=401;res.end('unauthorized');});
  await new Promise(ok=>forbidden.listen(0,'127.0.0.1',ok));
  try{
    await assert.rejects(ai.callCompatibleApi({baseUrl:`http://127.0.0.1:${forbidden.address().port}/v1`,model:'m',key:'bad',messages:[],retryCount:2}),/401/);
    assert.equal(denied,1);
  }finally{await new Promise(ok=>forbidden.close(ok));}
});
test('HTTP 代理转发 + 连接测试；不携带 token 到 GET 探测',async()=>{
  const backend=http.createServer((req,res)=>{res.end(JSON.stringify({choices:[{message:{content:'proxy-ok'}}]}));});
  await new Promise(ok=>backend.listen(0,'127.0.0.1',ok));
  let proxyHits=0;
  const proxy=http.createServer((req,res)=>{
    proxyHits++;
    const target=new URL(req.url);
    let body=[];req.on('data',chunk=>body.push(chunk));req.on('end',()=>{
      const forwarded=http.request(target,{method:req.method,headers:req.headers},upstream=>{
        res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
      });
      forwarded.end(Buffer.concat(body));
    });
  });
  await new Promise(ok=>proxy.listen(0,'127.0.0.1',ok));
  try {
    const baseUrl=`http://127.0.0.1:${backend.address().port}/v1`;
    const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
    assert.equal(await ai.callCompatibleApi({baseUrl,model:'demo',key:'x',messages:[],proxyUrl}),'proxy-ok');
    assert.equal((await ai.probeApiEndpoint(baseUrl,3000,proxyUrl)).statusCode,200);
    assert.equal(proxyHits,2);
  }finally {await new Promise(ok=>proxy.close(ok));await new Promise(ok=>backend.close(ok));}
});
test('v1.4 编辑内置说明：简洁版与详细版可分别修改，保存后悬停立即生效',async()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.version,'1.6.2');
  assert.equal(typeof commands['zhLinuxApiHover.editExplanation'],'function');
  const name='fork';
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:4}}),getText:()=>name,lineAt:()=>({text:'fork();'})};
  const before=await hoverFn(doc,{},{});
  assert.match(before.contents.value,/编辑解释/);
  assert.match(before.contents.value,/command:zhLinuxApiHover.editExplanation/);
  await commands['zhLinuxApiHover.editExplanation'](name);
  assert.match(lastPanel.webview.html,/简洁版/);
  assert.match(lastPanel.webview.html,/详细版/);
  const fields={
    b_summary:'创建一个独立的子进程（我自己写的简洁版）',b_params:'无需参数',
    b_success:'父进程返回子进程 PID，子进程返回 0',b_failure:'返回 -1，创建失败',
    proto:'pid_t fork(void);',summary:'我自己修改的详细解释，用于课堂复习。',params:'无参数',
    success:'父进程：返回子进程PID；子进程：返回0',failure:'错误返回 -1',note:'记得父进程 waitpid 回收子进程'
  };
  await lastPanel.handleMessage({type:'save',values:fields});
  assert.equal(lastPanel.lastResponse.ok,true);
  const after=await hoverFn(doc,{},{});
  assert.match(after.contents.value,/我自己写的简洁版/);
  assert.doesNotMatch(after.contents.value,/我自己修改的详细解释/);
  await commands['zhLinuxApiHover.showDetail'](name);
  assert.match(lastPanel.webview.html,/我自己修改的详细解释/);
  assert.match(lastPanel.webview.html,/我自己写的简洁版/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp,'offline-library.json'),'utf8')).entries.fork.brief.summary,fields.b_summary);
  assert.equal(settingsObj['ai.baseUrl']?.includes('safe-key'),false);
  const reloaded=new Storage(ctx());await reloaded.init();
  assert.equal(reloaded.offline.fork.brief.success,fields.b_success);
});
test('编辑合法性校验：不允许空返回值、过量参数或恶意 HTML，内置库不被改变',async()=>{
  await commands['zhLinuxApiHover.editExplanation']('fork');
  const bad={b_summary:'',b_params:'',b_success:'0',b_failure:'-1',proto:'int func();',summary:'foo',params:'x',success:'0',failure:'-1',note:''};
  await lastPanel.handleMessage({type:'save',values:bad});
  assert.equal(lastPanel.lastResponse.ok,false);
  assert.equal((new Storage(ctx())).offline.fork,undefined);
  const payload={...bad,b_summary:'<script>alert(1)</script>',b_params:Array(21).fill('x').join('\n')};
  await lastPanel.handleMessage({type:'save',values:payload});
  assert.equal(lastPanel.lastResponse.ok,false);
  assert.doesNotMatch(lastPanel.webview.html,/<script>alert\(1\)<\/script>/);
  // 删除本地覆盖后，回到插件内置库
  const store=new Storage(ctx());await store.init();await store.removeOffline('fork');
  await commands['zhLinuxApiHover.reloadOffline']();
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:4}}),getText:()=> 'fork',lineAt:()=>({text:'fork();'})};
  const hover=await hoverFn(doc,{},{});
  assert.doesNotMatch(hover.contents.value,/我自己写的简洁版/);
});
test('v1.5 默认按钮：留空仍使用旧版查询行为，出现可选要求弹窗',async()=>{
  assert.equal(require('../package.json').version,'1.6.2');
  assert.equal(typeof commands['zhLinuxApiHover.refreshFunction'],'function');
  assert.equal(typeof extension.promptAiInstructions,'function');
  const num=promptLog.length;
  const response=await extension.promptAiInstructions('fork',null);
  assert.equal(response,'');
  assert.equal(promptLog.length,num+1);
  assert.match(promptLog.at(-1).webview.html,/按默认规则解释/);
  assert.match(promptLog.at(-1).webview.html,/按照我的要求解释/);
  assert.match(promptLog.at(-1).webview.html,/textarea/);
});
test('取消 AI 补充要求不请求模型',async()=>{
  const original=commands['zhLinuxApiHover.refreshFunction'];
  nextPromptText=null;
  await original('fork');
  assert.match(promptLog.at(-1).webview.html,/取消/);
});
test('首次查询自定义补充要求：真正送达 API，且绕过旧缓存',async()=>{
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      server.last=JSON.parse(body);
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'fresh_custom_api',known:true,prototype:'int new_api(int arg);',summary:'自定义风格说明',params:['arg：传入整数'],success:'成功 0',failure:'失败 -1',note:'手册未核验'})}}]}));
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='demo';secret.value='test-secret';
    nextPromptText='请用两句话说明，尤其解释失败返回值';
    await commands['zhLinuxApiHover.explainFunction']('fresh_custom_api');
    assert.match(server.last.messages[1].content,/尤其解释失败返回值/);
    assert.match(lastPanel.webview.html,/自定义风格说明/);
  }finally{await new Promise(ok=>server.close(ok));}
});
test('定向修改只改失败说明：其余字段和人工简洁版都保留，确认后才覆盖离线库',async()=>{
  const old=['int new_api(int arg);','很喜欢的原来作用',['arg：很喜欢的原来参数'],'成功时返回 0','失败返回 -1','原来备注不要修改'];
  const brief={summary:'手写简洁作用',params:['arg：手写简洁参数'],success:'成功 0',failure:'失败 -1'};
  await commands['zhLinuxApiHover.reloadOffline']();
  const fileStore=new Storage(ctx());await fileStore.init();await fileStore.putOffline('new_api',old,'用户编辑','来源',brief);
  await commands['zhLinuxApiHover.reloadOffline']();
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      server.last=JSON.parse(body);
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'new_api',known:true,changes:{failure:'失败时返回 -1，同时 errno 为 EINVAL'}})}}]}));
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='demo';secret.value='test-secret';
    nextPromptText='只修改失败返回值，其他参数、作用、提醒一个字都不要改';
    await commands['zhLinuxApiHover.refreshFunction']('new_api');
    assert.match(server.last.messages[1].content,/只修改失败返回值/);
    assert.match(server.last.messages[1].content,/很喜欢的原来参数/);
    assert.match(lastPanel.webview.html,/EINVAL/);
    assert.match(lastPanel.webview.html,/手写简洁作用/);
    const storedBefore=JSON.parse(fs.readFileSync(path.join(tmp,'offline-library.json'),'utf8'));
    assert.equal(storedBefore.entries.new_api.entry[4],'失败返回 -1','未经确认不得改变离线库');
    const previousConfirm=vscode.window.showWarningMessage;
    vscode.window.showWarningMessage=async()=> '确认覆盖';
    try{await commands['zhLinuxApiHover.saveOffline']('new_api');}finally{vscode.window.showWarningMessage=previousConfirm;}
    const storedAfter=JSON.parse(fs.readFileSync(path.join(tmp,'offline-library.json'),'utf8'));
    assert.equal(storedAfter.entries.new_api.entry[4],'失败时返回 -1，同时 errno 为 EINVAL');
    assert.deepEqual(storedAfter.entries.new_api.entry.slice(0,4),old.slice(0,4));
    assert.equal(storedAfter.entries.new_api.entry[5],old[5]);
    assert.equal(storedAfter.entries.new_api.brief.summary,'手写简洁作用');
    assert.equal(storedAfter.entries.new_api.brief.failure,'失败时返回 -1，同时 errno 为 EINVAL');
  }finally{await new Promise(ok=>server.close(ok));}
});
test('只修改一个参数，保留其它详细参数和手写简洁参数',async()=>{
  const {mergeRevision}=require('../lib/revision');
  const prev={entry:['int f(int a,int b);','旧作用',['a：原参数','b：旧描述'],'成功0','失败-1','备注'],
    brief:{summary:'人工简洁作用',params:['a：人工简洁描述','b：另一条简洁描述'],success:'成功0',failure:'失败-1'}};
  const modified=mergeRevision('f',prev,{name:'f',known:true,changes:{},paramEdits:[{index:1,text:'b：修改这个参数的详细说明'}]});
  assert.equal(modified.entry[2][0],'a：原参数');
  assert.equal(modified.entry[2][1],'b：修改这个参数的详细说明');
  assert.equal(modified.brief.params[0],'a：人工简洁描述');
  assert.equal(modified.brief.summary,'人工简洁作用');
  assert.match(modified.brief.params[1],/修改这个参数/);
});
test('AI 只修改简洁版时无需改写任何详细字段',async()=>{
  const {mergeRevision}=require('../lib/revision');
  const previous={entry:['int f(void);','很详细的原作用',[],'成功 0','失败 -1','注意事项'],
    brief:{summary:'老简要作用',params:[],success:'成功 0',failure:'失败 -1'}};
  const changed=mergeRevision('f',previous,{name:'f',known:true,briefChanges:{summary:'更易懂的一句话'}});
  assert.deepEqual(changed.entry,previous.entry);
  assert.equal(changed.brief.summary,'更易懂的一句话');
  assert.equal(previous.brief.summary,'老简要作用');
});
test('不合法 AI 局部 JSON 不污染既有说明',async()=>{
  const {mergeRevision}=require('../lib/revision');
  const prev={entry:['int f(void);','已核验说明',[],'成功 0','失败 -1','备注']};
  assert.throws(()=>mergeRevision('f',prev,'{bad json'),/JSON/);
  assert.throws(()=>mergeRevision('f',prev,{name:'another',changes:{summary:'坏'}}),/不匹配/);
  assert.throws(()=>mergeRevision('f',prev,{name:'f',changes:{}}),/没有提交任何改动/);
  assert.throws(()=>mergeRevision('f',prev,{name:'f',changes:{params:[]},paramEdits:[{index:0,text:'x'}]}),/不能同时替换/);
  assert.equal(prev.entry[1],'已核验说明');
});
test('结构体 sockaddr_in 悬停离线中文说明：类型不是函数',async()=>{
  const lines=['#include <netinet/in.h>','struct sockaddr_in addr;'];
  const doc={lineCount:lines.length,lineAt:i=>({text:lines[i]}),getWordRangeAtPosition:()=>({start:{line:1,character:7},end:{line:1,character:18}}),getText:()=> 'sockaddr_in'};
  const hover=await hoverFn(doc,{line:1,character:9},{});
  assert.match(hover.contents.value,/IPv4 套接字地址结构体/);
  assert.match(hover.contents.value,/主要成员/);
  assert.match(hover.contents.value,/sin_port/);
  assert.doesNotMatch(hover.contents.value,/sockaddr\_in\(\)/);
});
test('类型别名、宏、结构体成员均支持直接悬停，仍不消耗 API',async()=>{
  const {inspectSymbol}=require('../lib/symbols');
  for(const item of [
    {name:'socklen_t',line:'socklen_t len = sizeof(addr);',kind:'typedef',need:/套接字地址结构长度/},
    {name:'AF_INET',line:'addr.sin_family = AF_INET;',kind:'macro',need:/IPv4 地址族/},
    {name:'sin_port',line:'addr.sin_port = htons(80);',kind:'member',need:/网络字节序/}
  ]){
    const index=item.line.indexOf(item.name);
    const range={start:{line:0,character:index},end:{line:0,character:index+item.name.length}};
    const doc={lineCount:1,lineAt:()=>({text:item.line}),getWordRangeAtPosition:()=>range,getText:()=>item.name};
    const sym=inspectSymbol(doc,range,item.name);
    assert.equal(sym.kind,item.kind);
    const hover=await hoverFn(doc,{line:0,character:index+1},{});
    assert.match(hover.contents.value,item.need);
  }
});
test('普通变量根据声明推断类型，不编造运行时值',async()=>{
  const {variableRecord}=require('../lib/symbols');
  const rec=variableRecord('addr','1: struct sockaddr_in addr;');
  assert.equal(rec.symbolKind,'variable');
  assert.match(rec.entry[1],/struct sockaddr_in/);
  assert.match(rec.entry[4],/不代表已知道变量当前的值/);
  const line='struct sockaddr_in addr;';
  const range={start:{line:0,character:19},end:{line:0,character:23}};
  const doc={lineCount:1,lineAt:()=>({text:line}),getWordRangeAtPosition:()=>range,getText:()=> 'addr'};
  const hover=await hoverFn(doc,{line:0,character:20},{});
  assert.match(hover.contents.value,/结合代码让 AI 解释/);
  assert.match(hover.contents.value,/变量/);
});
test('关键字与注释字符串不显示悬停；普通变量不自动 AI 查询',async()=>{
  const {inspectSymbol}=require('../lib/symbols');
  const line='int userValue = 3;';
  const range={start:{line:0,character:4},end:{line:0,character:13}};
  const doc={lineCount:1,lineAt:()=>({text:line}),getWordRangeAtPosition:()=>range,getText:()=> 'userValue'};
  assert.equal(inspectSymbol(doc,range,'userValue').kind,'variable');
  settingsObj['ai.hoverMode']='auto';
  const res=await hoverFn(doc,{line:0,character:5},{});
  assert.match(res.contents.value,/变量/);
  const kwDoc={...doc,getText:()=> 'int'};
  assert.equal(await hoverFn(kwDoc,{line:0,character:0},{}),undefined);
  assert.equal(inspectSymbol({lineAt:()=>({text:'// addr is comment'})},{start:{line:0,character:3},end:{line:0,character:7}},'addr'),null);
  settingsObj['ai.hoverMode']='manual';
});
test('非函数标识符 AI JSON 协议：确实传递类型、不假定函数返回值',async()=>{
  const {explainSymbol}=require('../lib/symbol-ai');
  let request=null;
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',s=>body+=s);req.on('end',()=>{
      request=JSON.parse(body);res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'custom_struct',known:true,
        prototype:'struct custom_struct { int value; };',summary:'用户定义的结构体',params:['value：成员'],
        success:'用于保存 value',failure:'需按定义初始化',note:'查看对应头文件'})}}]}));
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const result=await explainSymbol('custom_struct','struct',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'demo'},'example-key',{instructions:'用中文介绍成员'});
    assert.equal(result.symbolKind,'struct');
    assert.match(result.entry[1],/结构体/);
    assert.match(request.messages[0].content,/并非一定是函数/);
    assert.doesNotMatch(request.messages[1].content,/struct sockaddr_in addr;/);
    assert.match(request.messages[1].content,/用中文介绍成员/);
  }finally{await new Promise(ok=>server.close(ok));}
});
test('非函数元数据写入离线库并在新实例中恢复，兼容旧版 JSON',async()=>{
  const {Storage}=require('../lib/storage');
  const storage=new Storage(ctx());await storage.init();
  const entry=['struct user_type { int a; };','测试用户类型',['a：成员'],'适合使用','需要初始化',''];
  await storage.putOffline('user_type',entry,'用户保存','本地',null,'struct');
  const reopened=new Storage(ctx());await reopened.init();
  assert.equal(reopened.offline.user_type.symbolKind,'struct');
  const keys=Object.keys(reopened.offline);
  assert.ok(keys.includes('new_api'));
  assert.equal(typeof commands['zhLinuxApiHover.explainIdentifier'],'function');
});
test('变量 AI 请求：拒绝代码上下文后，不把附近源码发给服务端',async()=>{
  let lastRequest;
  const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    lastRequest=JSON.parse(body);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'myVariable',known:true,prototype:'int myVariable;',summary:'整数变量',params:[],success:'取值依赖程序',failure:'无法判断实际值',note:'未提供代码片段'})}}]}));
  });});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const oldWarn=vscode.window.showWarningMessage,oldEditor=vscode.window.activeTextEditor;
  const code=['int myVariable = 10;', 'char *password = "private-example-do-not-send";'];
  vscode.window.activeTextEditor={document:{lineCount:2,lineAt:n=>({text:code[n]})}};
  vscode.window.showWarningMessage=async()=> '仅发送名称';
  try{
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='demo';secret.value='test-key';nextPromptText='';
    await commands['zhLinuxApiHover.explainIdentifier']({name:'myVariable',kind:'variable',line:0,character:4});
    assert.equal(lastRequest.messages[1].content.includes('private-example-do-not-send'),false);
    assert.match(lastRequest.messages[1].content,/没有提供用户代码上下文/);
  }finally{vscode.window.showWarningMessage=oldWarn;vscode.window.activeTextEditor=oldEditor;await new Promise(ok=>server.close(ok));}
});
test('变量 AI 请求：明确授权后仅发送有限的局部代码而非整份文件',async()=>{
  let lastRequest;
  const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    lastRequest=JSON.parse(body);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'myValueB',known:true,prototype:'int myValueB;',summary:'本地值变量',params:[],success:'保存数值',failure:'运行时数值不能只凭名称推断',note:'局部代码提供上下文'})}}]}));
  });});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const oldWarn=vscode.window.showWarningMessage,oldEditor=vscode.window.activeTextEditor;
  const code=['int myValueB = 20;', 'myValueB++;'];
  vscode.window.activeTextEditor={document:{lineCount:2,lineAt:n=>({text:code[n]})}};
  vscode.window.showWarningMessage=async()=> '允许发送片段';
  try{
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='demo';secret.value='test-key';nextPromptText='';
    await commands['zhLinuxApiHover.explainIdentifier']({name:'myValueB',kind:'variable',line:0,character:4});
    assert.match(lastRequest.messages[1].content,/int myValueB = 20/);
    assert.match(lastRequest.messages[1].content,/myValueB\+\+/);
    assert.equal(lastRequest.messages[1].content.includes('test-key'),false);
  }finally{vscode.window.showWarningMessage=oldWarn;vscode.window.activeTextEditor=oldEditor;await new Promise(ok=>server.close(ok));}
});
test('局部变量悬停链接可打开完整说明与编辑页，而不是提示未找到',async()=>{
  const oldEditor=vscode.window.activeTextEditor;
  const code=['struct sockaddr_in localAddr;'];
  vscode.window.activeTextEditor={document:{lineCount:1,lineAt:i=>({text:code[i]})},selection:{active:{line:0,character:19}}};
  try{
    await commands['zhLinuxApiHover.showDetail']({name:'localAddr',kind:'variable',line:0,character:19});
    assert.match(lastPanel.webview.html,/变量 localAddr/);
    await commands['zhLinuxApiHover.editExplanation']({name:'localAddr',kind:'variable',line:0,character:19});
    assert.match(lastPanel.webview.html,/编辑 localAddr 中文解释/);
    assert.match(lastPanel.webview.html,/典型用途/);
  }finally{vscode.window.activeTextEditor=oldEditor;}
});
test('多行 C 代码原样保留换行缩进并防止 HTML 注入',async()=>{
  const {segments,richMarkdown,richHtml}=require('../lib/rich-render');
  const c=['说明：','','#include <sys/socket.h>','int main(void)','{','    // socket 注释','    if (bind(fd,','             (const struct sockaddr *)&addr,','             sizeof(addr)) == -1) {','        perror("bind");','    }','}','','解释结束。'].join('\n');
  assert.equal(segments(c).filter(x=>x.type==='code').length,1);
  assert.ok(richMarkdown(c).includes('             (const struct sockaddr *)&addr,'));
  assert.ok(richMarkdown(c).includes('##')===false);
  assert.match(richHtml(c),/<pre class="c-snippet"><code>#include &lt;sys\/socket\.h&gt;/);
  assert.equal(richHtml('<script>alert(1)</script>').includes('<script>'),false);
});
test('旧离线说明中的 C 示例无需迁移，悬停与详细页正确保留缩进',async()=>{
  const old=settingsObj['hover.detailMode'];
  const entry=['int example(void);','socket bind',[],'成功','失败','#include <sys/socket.h>\n\nint main(void) {\n    return 0;\n}'];
  const disk=new Storage(ctx());await disk.init();await disk.putOffline('multiline_api',entry,'用户离线词条','旧格式');
  await commands['zhLinuxApiHover.reloadOffline']();
  const doc={getWordRangeAtPosition:()=>({end:{line:0,character:13}}),getText:()=> 'multiline_api',lineAt:()=>({text:'multiline_api();'})};
  try{
    settingsObj['hover.detailMode']='full';
    const hover=await hoverFn(doc,{line:0,character:1},{});
    assert.match(hover.contents.value,/##/);
    assert.ok(hover.contents.value.includes('    return 0;'));
    await commands['zhLinuxApiHover.showDetail']('multiline_api');
    assert.ok(lastPanel.webview.html.includes('white-space:pre;overflow-x:auto'));
    assert.ok(lastPanel.webview.html.includes('<pre class="c-snippet"><code>#include &lt;sys/socket.h&gt;'));
  } finally {settingsObj['hover.detailMode']=old;}
});
test('v1.6.2 待审核结果可关闭并重开；重启仍在；不自动覆盖旧词条',async()=>{
  assert.equal(typeof commands['zhLinuxApiHover.reviewPending'],'function');
  const name='durable_api';
  const old=['int durable_api(void);','旧版解释，不应被自动覆盖',[], '成功 0','失败 -1','旧备注'];
  const store=new Storage(ctx());await store.init();await store.putOffline(name,old,'用户离线词条','手动校对');
  await commands['zhLinuxApiHover.reloadOffline']();
  const server=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      server.count=(server.count||0)+1;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name,known:true,prototype:'int durable_api(void);',summary:'新版 AI 解释',params:[],success:'成功 123',failure:'失败 -1',note:'新备注'})}}]}));
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='review-test';secret.value='test-secret';nextPromptText='';
    await commands['zhLinuxApiHover.refreshFunction'](name);
    assert.equal(lastPanel.viewType,'zhLinuxAiReview');
    assert.match(lastPanel.webview.html,/确认保存到离线库/);
    assert.match(lastPanel.webview.html,/关闭页面.*重启 VS Code/);
    assert.match(lastPanel.webview.html,/新版 AI 解释/);
    assert.match(lastPanel.webview.html,/旧版解释，不应被自动覆盖/);
    const disk=new Storage(ctx());await disk.init();
    assert.equal(disk.offline[name].entry[1],'旧版解释，不应被自动覆盖');
    assert.equal(disk.pending[name].entry[1],'新版 AI 解释');
    assert.ok(!JSON.stringify(disk.pending).includes('test-secret'));
    const previous=lastPanel;
    previous.dispose();
    await commands['zhLinuxApiHover.reviewPending'](name);
    assert.equal(lastPanel.viewType,'zhLinuxAiReview');
    assert.match(lastPanel.webview.html,/新版 AI 解释/);
    const doc={getWordRangeAtPosition:()=>({end:{line:0,character:11}}),getText:()=>name,lineAt:()=>({text:`${name}();`})};
    const hover=await hoverFn(doc,{line:0,character:1},{});
    assert.match(hover.contents.value,/查看待审核 AI 结果/);
    const originalWarning=vscode.window.showWarningMessage;
    try {
      vscode.window.showWarningMessage=async()=>undefined;
      await lastPanel.handleMessage({type:'save'});
      assert.equal(lastPanel.lastResponse.ok,false,'取消覆盖后保留待审核结果');
      const unchanged=new Storage(ctx());await unchanged.init();
      assert.equal(unchanged.offline[name].entry[1],'旧版解释，不应被自动覆盖');
      assert.ok(unchanged.pending[name]);
      vscode.window.showWarningMessage=async()=> '确认覆盖';
      await lastPanel.handleMessage({type:'save'});
      assert.equal(lastPanel.lastResponse.ok,true);
      const accepted=new Storage(ctx());await accepted.init();
      assert.equal(accepted.offline[name].entry[1],'新版 AI 解释');
      assert.equal(accepted.pending[name],undefined);
      assert.equal(server.count,1,'重复打开审核页绝不重新请求 AI');
    } finally {vscode.window.showWarningMessage=originalWarning;}
  }finally{await new Promise(ok=>server.close(ok));}
});
test('v1.6.2 放弃草稿不影响旧离线说明；旧窗口不能误存新草稿',async()=>{
  const name='review_discard_api';
  const entry=['int review_discard_api();','原始说明',[], '0','-1','原始备注'];
  const persistent=new Storage(ctx());await persistent.init();await persistent.putOffline(name,entry,'原用户说明');
  await commands['zhLinuxApiHover.reloadOffline']();
  // 直接经扩展激活流程产生待审核结果，避免依赖之前的通知弹窗。
  const server=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name,known:true,prototype:'int review_discard_api();',summary:'AI 草稿内容',params:[],success:'0',failure:'-1',note:'补充'})}}]}));});
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {
    settingsObj['ai.baseUrl']=`http://127.0.0.1:${server.address().port}/v1`;
    settingsObj['ai.model']='review-test';secret.value='test-secret';nextPromptText='';
    await commands['zhLinuxApiHover.refreshFunction'](name);
    const oldPanel=lastPanel;
    await commands['zhLinuxApiHover.refreshFunction'](name);
    await oldPanel.handleMessage({type:'save'});
    assert.equal(oldPanel.lastResponse.ok,false);
    assert.match(oldPanel.lastResponse.message,/新结果替代/);
    await lastPanel.handleMessage({type:'discard'});
    assert.equal(lastPanel.lastResponse.ok,true);
    const disk=new Storage(ctx());await disk.init();
    assert.equal(disk.offline[name].entry[1],'原始说明');
    assert.equal(disk.pending[name],undefined);
  } finally {await new Promise(ok=>server.close(ok));}
});
(async()=>{
  let errors=0;
  for (const t of tests){
    try{await t.fn();process.stdout.write('PASS '+t.name+'\n');}
    catch(e){errors++;process.stderr.write('FAIL '+t.name+'\n'+e.stack+'\n');}
  }
  fs.rmSync(tmp,{recursive:true,force:true});
  if (errors) process.exitCode=1;
  else console.log(`全部 ${tests.length} 项测试通过`);
})();
