'use strict';
const http=require('http');
const https=require('https');
const tls=require('tls');

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  let url;
  try {url=new URL(proxyUrl);} catch {throw new Error('代理地址格式错误，需要如 http://127.0.0.1:7890');}
  if (!['http:','https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 代理；暂不支持 SOCKS 代理');
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname!=='/'))
    throw new Error('代理地址仅能包含协议、主机和端口；请勿把代理密码写进配置');
  return url;
}
function proxyAgentForHttps(target, proxy) {
  const agent=new https.Agent({keepAlive:false});
  const pending=new Set();
  agent.cancelPending=()=>{for(const socket of pending){socket.destroy();}pending.clear();};
  agent.createConnection=(options,callback)=>{
    const destination=`${target.hostname}:${target.port||443}`;
    const connector=(proxy.protocol==='https:'?https:http).request(proxy,{
      method:'CONNECT',path:destination,agent:false,
      headers:{Host:destination}
    });
    pending.add(connector);
    let completed=false;
    const finish=(err,socket)=>{if(completed)return;completed=true;pending.delete(connector);callback(err,socket);};
    connector.once('connect',(res,socket,head)=>{
      if(res.statusCode!==200){
        socket.destroy();
        const err=new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`);
        err.statusCode=res.statusCode;
        finish(err);return;
      }
      if (head?.length) socket.unshift(head);
      const secure=tls.connect({socket,servername:target.hostname,ALPNProtocols:['http/1.1']});
      pending.add(secure);
      secure.once('secureConnect',()=>{pending.delete(secure);finish(null,secure);});
      secure.once('error',e=>{pending.delete(secure);finish(e);});
    });
    connector.once('error',finish);
    connector.end();
    return undefined;
  };
  return agent;
}
function requestText(uri,{method='POST',body=null,headers={},timeoutMs=90000,signal,proxyUrl,maxResponse=1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){const e=new Error('请求已取消');e.name='AbortError';return reject(e);}
    let req,proxy,agent,proxyOptions;
    try {
      proxy=parseProxy(proxyUrl);
      proxyOptions=proxy && uri.protocol==='http:'?{
        protocol:proxy.protocol,hostname:proxy.hostname,port:proxy.port,method,
        path:uri.href,headers:{...headers,Host:uri.host}
      }:null;
      agent=proxy && uri.protocol==='https:'?proxyAgentForHttps(uri,proxy):null;
    }catch(e){return reject(e);}
    const client=proxyOptions?(proxy.protocol==='https:'?https:http):(uri.protocol==='https:'?https:http);
    const params=proxyOptions||{method,headers,agent:agent||undefined};
    let settled=false;
    let alarm;
    let abortListener;
    const complete=(err,value)=>{
      if(settled)return;
      settled=true;
      clearTimeout(alarm);
      if(signal && abortListener)signal.removeEventListener('abort',abortListener);
      if(agent){agent.cancelPending();agent.destroy();}
      if(err)reject(err);else resolve(value);
    };
    try {
      const onResponse=res=>{
        let chunks=[],bytes=0;
        res.on('data',chunk=>{
          bytes+=chunk.length;
          if(bytes>maxResponse){
            const err=new Error('AI 响应超过大小限制，已终止请求');err.code='E_RESPONSE_TOO_LARGE';
            req.destroy(err);
          } else chunks.push(chunk);
        });
        res.once('end',()=>complete(null,{statusCode:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),headers:res.headers}));
        res.once('error',complete);
        res.once('aborted',()=>{const err=new Error('服务器中途断开响应');err.code='ECONNRESET';complete(err);});
      };
      req=proxyOptions ? client.request(params,onResponse) : client.request(uri,params,onResponse);
    }catch(e){return complete(e);}
    abortListener=()=>{const err=new Error('请求已取消');err.name='AbortError';req.destroy(err);};
    signal?.addEventListener('abort',abortListener,{once:true});
    req.once('error',complete);
    alarm=setTimeout(()=>{
      const e=new Error(`AI 网络请求超时（${(timeoutMs/1000).toFixed(1)} 秒）`);e.code='ETIMEDOUT';req.destroy(e);
    },timeoutMs);
    if(body)req.end(body);else req.end();
  });
}
module.exports={parseProxy,requestText};
