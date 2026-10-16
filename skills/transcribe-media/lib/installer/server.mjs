import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileSystemError } from '../errors.mjs';

const assets=new Map([
 ['/', ['dashboard/index.html','text/html; charset=utf-8']],
 ['/dashboard.css',['dashboard/dashboard.css','text/css; charset=utf-8']],
 ['/dashboard.js',['dashboard/dashboard.js','text/javascript; charset=utf-8']],
 ['/setup',['dashboard/setup.html','text/html; charset=utf-8']],
 ['/setup.css',['dashboard/setup.css','text/css; charset=utf-8']],
 ['/setup.js',['dashboard/setup.js','text/javascript; charset=utf-8']],
 ['/provider-guides.mjs',['provider-guides.mjs','text/javascript; charset=utf-8']]
]);
const actions={select:'select',inspect:'inspect',plan:'plan',install:'install',configure:'configure','skip-provider':'skipProvider',finish:'finish',cancel:'cancel',stop:'close'};
// Действия страницы настроек и их поля. Ключ принимает только save-key, и только с токеном страницы.
const settingsActions={refresh:['settingsRefresh',[]],'save-key':['settingsSaveKey',['provider','key']],verify:['settingsVerify',['provider']],'remove-key':['settingsRemoveKey',['provider']],primary:['settingsPrimary',['provider']],configure:['configure',['settings']]};
const settingKeys=['language','interval','formats','diarize','speakerCount','outputRoot'];
const json=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
const safeError=error=>{const system=error?.installerSafe?null:fileSystemError(error);return {code:system?.code??(/^[A-Z_]+$/.test(error?.code||'')?error.code:'INSTALLER_ERROR'),message:error?.installerSafe?error.message:system?.message??'Операция не выполнена. Проверьте параметры.'};};
function authenticated(req,capability){const got=Buffer.from(String(req.headers.authorization||''));const wanted=Buffer.from('Bearer '+capability);return got.length===wanted.length && timingSafeEqual(got,wanted);}
function validSettings(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(settingsActions,body.action))return false;
 const fields=settingsActions[body.action][1];
 if(Object.keys(body).some(key=>key!=='action'&&!fields.includes(key))||fields.some(key=>body[key]===undefined))return false;
 if(body.provider!==undefined&&!['deepgram','assemblyai'].includes(body.provider))return false;
 if(body.key!==undefined&&(typeof body.key!=='string'||body.key.length>8192))return false;
 if(body.settings!==undefined&&(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings)||Object.keys(body.settings).some(key=>!settingKeys.includes(key))))return false;
 return true;
}
export function createHandler(engine,{origin,capability,browserCapability,bodyLimit=16384,onShutdown,onActivity=()=>{}}={}) {
 const host=new URL(origin).host,operations=new Map();let sequence=0,active=null;
 const handler=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)||req.headers.host!==host || req.headers.origin && req.headers.origin!==origin)return json(res,403,{error:'Запрос вне локальной сессии.'});
  let url;try{url=new URL(req.url,origin);}catch{return json(res,400,{error:'Некорректный адрес.'});}
  if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,engine.snapshot());
  if(req.method==='GET'&&assets.has(url.pathname)){
   const [file,type]=assets.get(url.pathname);res.setHeader('Content-Type',type);
   let content=readFileSync(new URL('./'+file,import.meta.url));
   if(url.pathname==='/setup'&&browserCapability)content=content.toString('utf8').replace('</head>',`<meta name="settings-capability" content="${browserCapability}"></head>`);
   res.end(content);return;
  }
  const page=url.pathname==='/api/settings';
  if(!['/api/command','/api/operation','/api/session'].includes(url.pathname)&&!page)return json(res,404,{error:'Маршрут не найден.'});
  if(page&&!browserCapability||!authenticated(req,page?browserCapability:capability))return json(res,401,{error:'Нужна локальная сессия.'});
  onActivity();
  if(url.pathname==='/api/session')return json(res,req.method==='GET'?200:405,req.method==='GET'?{id:engine.snapshot().id}:{error:'Нужен GET.'});
  if(url.pathname==='/api/operation'){
   if(req.method!=='GET')return json(res,405,{error:'Нужен GET.'});
   const operation=operations.get(url.searchParams.get('id'));json(res,operation?200:404,operation||{error:'Операция не найдена.'});
   if(operation?.command==='stop'&&operation.status==='done'&&onShutdown){setImmediate(()=>Promise.resolve(onShutdown()).catch(()=>{}));}return;
  }
  if(req.method!=='POST')return json(res,405,{error:'Нужен POST.'});
  // Страница отправляет ключ через fetch того же источника: браузер обязан прислать Origin, а тело — JSON.
  if(page&&req.headers.origin!==origin)return json(res,403,{error:'Запрос вне локальной сессии.'});
  if((page||req.headers['content-type'])&&String(req.headers['content-type']||'').split(';')[0]!=='application/json')return json(res,415,{error:'Нужен JSON.'});
  let body,size=0;const chunks=[];
  if(Number(req.headers['content-length'])>bodyLimit)return json(res,413,{error:'Слишком большой запрос.'});
  try{for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>bodyLimit)return json(res,413,{error:'Слишком большой запрос.'});chunks.push(bytes);}body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{return json(res,400,{error:'Некорректный JSON.'});}
  if(page){
   if(!validSettings(body))return json(res,400,{error:{code:'INVALID_INPUT',message:'Некорректное действие страницы настроек.'}});
   const [method,fields]=settingsActions[body.action];
   const args=body.action==='configure'?body.settings:Object.fromEntries(fields.map(key=>[key,body[key]]));
   try{return json(res,200,await engine[method](fields.length?args:undefined));}
   catch(error){const safe=safeError(error);return json(res,['BUSY','CLOSED'].includes(safe.code)?409:400,{error:safe});}
  }
  if(!body || typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(actions,body.command)||Object.keys(body).some(k=>!['command','args'].includes(k)))return json(res,400,{error:'Неизвестная команда.'});
  // Ключ передаётся только странице настроек; управляющий API принимает белый список полей.
  const keys={select:['agent','scope','projectRoot','inPlace'],inspect:['allowCheck'],install:['allowInstall','update','planId'],configure:settingKeys};
  if(body.args!==undefined && (!body.args||typeof body.args!=='object'||Array.isArray(body.args)||Object.keys(body.args).some(k=>!(keys[body.command]||[]).includes(k))))return json(res,400,{error:'Некорректные параметры.'});
  if(active && !['cancel','stop'].includes(body.command))return json(res,409,{error:'Другая операция ещё выполняется.'});
  const id=String(++sequence),operation={id,command:body.command,status:'running'};operations.set(id,operation);
  // Возвращаем принятие сразу; state и polling остаются доступны во время установки/отмены.
  const previous=active;
  const task=Promise.resolve().then(async()=>{if(body.command==='stop'&&previous&&engine.snapshot().operation!=='install')await previous;return engine[actions[body.command]](body.args);}).then(result=>{operation.status='done';operation.result=result;},error=>{operation.status='error';operation.error=safeError(error);}).finally(()=>{if(active===task)active=null;while(operations.size>30){const first=operations.keys().next().value;if(operations.get(first).status==='running')break;operations.delete(first);}});
  if(body.command!=='cancel')active=task;
  return json(res,202,{id,status:'running'});
 };
 handler.isBusy=()=>[...operations.values()].some(operation=>operation.status==='running');
 return handler;
}
export async function startServer(engine,{createServer=http.createServer,...options}={}) {
 const capability=options.capability||randomBytes(32).toString('hex');let handler;
 const browserCapability=options.browserCapability||randomBytes(32).toString('hex');
 const server=createServer((req,res)=>handler(req,res).catch(()=>json(res,500,{error:'Локальная панель недоступна.'})));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 server.requestTimeout=10000;server.headersTimeout=10000;
 let lastActivity=Date.now(),idle,closing;
 const close=()=>{clearInterval(idle);return closing||=(new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();}));};
 const shutdown=async()=>{await engine.close();await (options.onShutdown?options.onShutdown():close());};
 const url=`http://127.0.0.1:${server.address().port}`;handler=createHandler(engine,{...options,origin:url,capability,browserCapability,onShutdown:shutdown,onActivity:()=>{lastActivity=Date.now();}});
 const idleTimeoutMs=options.idleTimeoutMs??30*60*1000;
 idle=setInterval(()=>{if(Date.now()-lastActivity>=idleTimeoutMs&&!engine.snapshot().operation&&!handler.isBusy()){clearInterval(idle);shutdown().catch(()=>{});}},Math.min(30000,idleTimeoutMs));idle.unref?.();
 return {url,capability,close};
}
