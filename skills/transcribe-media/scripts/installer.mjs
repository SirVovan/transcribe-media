import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir,open,readFile,writeFile,unlink,lstat,readdir,rm,stat } from 'node:fs/promises';
import { createInstaller } from '../lib/installer/index.mjs';
import { defaultPaths } from '../lib/config/index.mjs';
import { startServer } from '../lib/installer/server.mjs';
import { describeEvent,createProgressFilter } from '../lib/installer/progress-text.mjs';
import { fileSystemError } from '../lib/errors.mjs';

export const HELP=`Мастер transcribe-media (Node.js 22+)
  node scripts/installer.mjs start [--state PATH] [--config PATH] [--node PATH] [--recover]
  node scripts/installer.mjs serve [--state PATH] [--config PATH] [--node PATH] [--recover] [--detach] [--open]
  node scripts/installer.mjs connect [--state PATH] [--config PATH] [--recover]
  node scripts/installer.mjs settings [--state PATH] [--config PATH] [--node PATH]
  node scripts/installer.mjs status [--session PATH]
  node scripts/installer.mjs select --agent codex|claude|both --scope user|project [--project PATH] [--session PATH]
  node scripts/installer.mjs select --in-place [--session PATH]
  node scripts/installer.mjs inspect --allow-check [--session PATH]
  node scripts/installer.mjs plan [--session PATH]
  node scripts/installer.mjs install --allow-install --plan-id HASH [--update] [--session PATH]
  node scripts/installer.mjs configure --language auto|ru --interval 30 --formats txt,srt,vtt --diarize|--no-diarize --speakers auto|N --output PATH [--session PATH]
  node scripts/installer.mjs skip-provider|finish|cancel|stop [--session PATH]
start — вопросы в терминале; serve — процесс для управления из локального чата; connect — подключение сервиса в терминале (ключ вводится скрыто); settings — страница настроек в браузере.
Ключ из чата вводится только на странице настроек: адрес панели + /setup.
serve сообщает URL панели и sessionPath. Все клиентские команды используют приватную сессию.
--detach запускает serve отдельным фоновым процессом и сразу возвращает URL и sessionPath; --open открывает панель в браузере.
Пока клиентская команда ждёт операцию, ход установки печатается в stderr; итог — JSON в stdout.
select --in-place — скилл уже установлен из GitHub (/plugin install, npx skills add или установщик Codex): мастер ставит программы и настройки, скилл не копирует; недостающий transcribe-settings кладёт рядом.
--recover разрешает восстановить только собственную сессию после подтверждённого завершения её процесса.
Не передавайте ключи в команды.
Закрытие панели не останавливает мастер; stop или Ctrl+C безопасно закрывает процесс serve.
Без управляющих запросов serve закрывается через 30 минут; активную операцию не обрывает.
`;
const fail=(code,message)=>Object.assign(new Error(message),{code,installerSafe:true});
const valueFlags=['state','config','node','session','agent','scope','project','plan-id','language','interval','formats','speakers','output'];
const booleanFlags=['allow-check','allow-install','update','diarize','no-diarize','recover','detach','open','in-place'];
const allowed={start:['state','config','node','recover'],settings:['state','config','node'],serve:['state','config','node','recover','detach','open'],connect:['state','config','node','recover'],status:['session'],select:['session','agent','scope','project','in-place'],inspect:['session','allow-check'],plan:['session'],install:['session','allow-install','update','plan-id'],configure:['session','language','interval','formats','diarize','no-diarize','speakers','output'],'skip-provider':['session'],finish:['session'],cancel:['session'],stop:['session']};
function parse(args){const command=args[0]||'help',flags={};if(['help','--help','-h'].includes(command))return {command:'help',flags};if(!allowed[command])throw fail('COMMAND','Неизвестная команда. Используйте --help.');for(let i=1;i<args.length;i++){const key=args[i].slice(2);if(!args[i].startsWith('--')||!allowed[command].includes(key)||Object.hasOwn(flags,key))throw fail('ARGUMENT','Неподдержанный или повторный параметр. Используйте --help.');if(booleanFlags.includes(key))flags[key]=true;else if(valueFlags.includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))flags[key]=args[++i];else throw fail('ARGUMENT','Нужно значение параметра.');}if(flags.diarize&&flags['no-diarize'])throw fail('ARGUMENT','Выберите один вариант разделения участников.');return {command,flags};}
async function guarded(file){let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{const stat=await lstat(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw fail('SESSION_PATH','Ссылки в пути сессии запрещены.');}catch(e){if(e.code!=='ENOENT')throw e;}}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validOwner(o,statePath){return o?.version===1&&o.statePath===statePath&&Number.isInteger(o.pid)&&o.pid>0&&typeof o.owner==='string'&&uuid.test(o.owner);}
export async function acquireLease(statePath,{recover=false,isAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}}={}){
 statePath=path.resolve(statePath);const lockPath=statePath+'.owner.json';await guarded(lockPath);await mkdir(path.dirname(lockPath),{recursive:true});const owner={version:1,statePath,pid:process.pid,owner:randomUUID()};let handle;
 try{handle=await open(lockPath,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=JSON.parse(await readFile(lockPath,'utf8'));}catch{throw fail('OWNER_UNKNOWN','Состояние занято неизвестным владельцем; автоматическое восстановление запрещено.');}if(!validOwner(old,statePath))throw fail('OWNER_UNKNOWN','Нельзя подтвердить владельца состояния.');
  let alive;try{alive=isAlive(old.pid);}catch{throw fail('OWNER_UNKNOWN','Статус процесса неизвестен. Владение не изменено.');}if(alive)throw fail('OWNER_ACTIVE','Мастер уже запущен. Используйте его сессию или закройте этот процесс.');if(!recover)throw fail('OWNER_STALE','Прошлый процесс завершён. Для продолжения повторите start или serve с --recover и тем же --state.');
  const recoveryPath=lockPath+'.recovery';let recovery;await guarded(recoveryPath);try{recovery=await open(recoveryPath,'wx',0o600);}catch{throw fail('OWNER_UNKNOWN','Восстановление уже выполняется или требует проверки владельца.');}
  try{await guarded(lockPath);const current=JSON.parse(await readFile(lockPath,'utf8'));if(current.owner!==old.owner||isAlive(current.pid)!==false)throw fail('OWNER_CHANGED','Владелец изменился. Восстановление отменено.');await unlink(lockPath);handle=await open(lockPath,'wx',0o600);}finally{await recovery.close();await unlink(recoveryPath);}
 }
 try{await handle.writeFile(JSON.stringify(owner));}finally{await handle.close();}
 let released=false;return {owner,async release(){if(released)return;await guarded(lockPath);const current=JSON.parse(await readFile(lockPath,'utf8'));if(current.owner!==owner.owner)throw fail('OWNER_CHANGED','Владелец изменился; чужой lock не удалён.');await unlink(lockPath);released=true;}};
}
export async function readSession(file){file=path.resolve(file);await guarded(file);let s;try{s=JSON.parse(await readFile(file,'utf8'));}catch{throw fail('SESSION_MISSING','Сессия не найдена. Запустите serve.');}let url;try{url=new URL(s.url);}catch{throw fail('SESSION_INVALID','Некорректная локальная сессия.');}if(s.version!==1||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password||typeof s.capability!=='string'||!/^([a-f0-9]{64})$/.test(s.capability)||typeof s.id!=='string')throw fail('SESSION_INVALID','Некорректная локальная сессия.');return s;}
async function api(session,route,{fetch:fetcher=fetch,method='GET',body}={}){let response;try{response=await fetcher(session.url+route,{method,headers:{authorization:'Bearer '+session.capability,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});}catch{throw fail('SESSION_OFFLINE','Мастер недоступен. Если процесс завершён, используйте start/serve --recover.');}const result=await response.json();if(!response.ok)throw fail(result.error?.code||'COMMAND_FAILED',typeof result.error==='string'?result.error:result.error?.message||'Команда не выполнена.');return result;}
function commandArgs(command,f){switch(command){case 'select':return {...(f.agent?{agent:f.agent}:{}),...(f.scope?{scope:f.scope}:{}),...(f.project?{projectRoot:path.resolve(f.project)}:{}),...(f['in-place']?{inPlace:true}:{})};case 'inspect':return {allowCheck:!!f['allow-check']};case 'install':return {allowInstall:!!f['allow-install'],update:!!f.update,planId:f['plan-id']};case 'configure':return {...(f.language?{language:f.language}:{}),...(f.interval?{interval:Number(f.interval)}:{}),...(f.formats?{formats:f.formats.split(',')}:{}),...(f.diarize?{diarize:true}:{}),...(f['no-diarize']?{diarize:false}:{}),...(f.speakers?{speakerCount:f.speakers==='auto'?'auto':Number(f.speakers)}:{}),...(f.output?{outputRoot:path.resolve(f.output)}:{})};default:return undefined;}}
export function openUrl(url,{platform=process.platform,spawnImpl=spawn}={}){
 const [command,commandArgs]=platform==='win32'?['explorer.exe',[url]]:platform==='darwin'?['open',[url]]:['xdg-open',[url]];
 try{const child=spawnImpl(command,commandArgs,{detached:true,stdio:'ignore',windowsHide:true});child.on?.('error',()=>{});child.unref?.();}catch{/* Браузер не открылся: ссылка уже напечатана. */}
}
// Стартовые HTML-панели запускателя живут во временной папке; свою удаляем при выходе, чужие — если им больше суток.
const startPanelPrefix='transcribe-start-';
async function cleanupStartPanels({current,tmp=os.tmpdir(),now=Date.now()}={}){
 if(current&&path.basename(path.dirname(current)).startsWith(startPanelPrefix))await rm(path.dirname(current),{recursive:true,force:true}).catch(()=>{});
 if(current!==undefined)return;
 for(const entry of await readdir(tmp,{withFileTypes:true}).catch(()=>[])){if(!entry.isDirectory()||!entry.name.startsWith(startPanelPrefix))continue;const dir=path.join(tmp,entry.name);const info=await stat(dir).catch(()=>null);if(info&&now-info.mtimeMs>24*3600*1000)await rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
// Фоновый процесс пишет весь свой вывод в журнал: на Windows у него нет консоли, куда можно писать.
const serveLogVariable='TRANSCRIBE_SERVE_LOG';
// На Windows дочерний процесс наследует открытые каналы вывода цепочки PowerShell → node, и вызвавшая команда ждёт,
// пока фоновый мастер не завершится. Start-Process без перенаправления создаёт процесс без наследования каналов.
async function startDetached(argv,{env,platform=process.platform}){
 if(platform!=='win32'){const child=spawn(process.execPath,argv,{detached:true,stdio:'ignore',env});child.unref();return child.pid;}
 const quote=value=>'"'+String(value).replace(/"/g,'\\"')+'"';
 const script=`$p=Start-Process -FilePath '${process.execPath.replace(/'/g,"''")}' -ArgumentList '${argv.map(quote).join(' ').replace(/'/g,"''")}' -WindowStyle Hidden -PassThru; $p.Id`;
 const output=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,stdio:['ignore','pipe','ignore']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('close',()=>resolve(text));});
 const pid=Number(String(output).trim().split(/\s+/).at(-1));if(!Number.isInteger(pid)||pid<=0)throw fail('DETACH_FAILED','Не удалось запустить мастер в фоне.');return pid;
}
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// serve --detach: мастер работает отдельным процессом, а команда возвращается сразу после его готовности.
// Так ассистент в чате не упирается в свой тайм-аут команды и не убивает мастер вместе с ней.
async function detachServe(args,{statePath,sessionPath,print,deps,env}){
 const logPath=statePath+'.serve.log';await guarded(logPath);await mkdir(path.dirname(logPath),{recursive:true});await writeFile(logPath,'',{mode:0o600});
 const pid=await (deps.startDetached||startDetached)([fileURLToPath(import.meta.url),...args.filter(arg=>arg!=='--detach')],{env:{...env,[serveLogVariable]:logPath}});
 const wait=deps.delay||(ms=>new Promise(resolve=>setTimeout(resolve,ms))),alive=deps.isAlive||processAlive;
 for(const started=Date.now();;await wait(200)){
  let session=null;try{session=JSON.parse(await readFile(sessionPath,'utf8'));}catch{/* мастер ещё запускается */}
  if(session?.pid===pid){const result={url:session.url,sessionPath,id:session.id,nodePath:process.execPath,pid,log:logPath};print(result);return result;}
  if(!alive(pid)){
   const text=(await readFile(logPath,'utf8').catch(()=>'')).trim();
   if(text.startsWith('{')){try{const reused=JSON.parse(text);print(reused);return reused;}catch{/* не JSON — значит ошибка */}}
   throw fail('DETACH_FAILED',(text.split(/\r?\n/).filter(Boolean).at(-1)||'Мастер завершился при запуске.')+` Журнал: ${logPath}`);
  }
  if(Date.now()-started>60000)throw fail('DETACH_TIMEOUT',`Мастер не сообщил о готовности за 60 секунд. Журнал: ${logPath}`);
 }
}
// settings: страница настроек в браузере. Работающий сервер этой сессии переиспользуется, второй не запускается;
// иначе сервер запускается в фоне так же, как serve --detach, и сам выключается через 30 минут без действий.
async function openSettings({flags,statePath,sessionPath,print,deps,env,openBrowser}){
 let panelUrl=null,started=null;
 try{const session=await deps.readSession(sessionPath);const identity=await api(session,'/api/session',deps);if(identity.id===session.id)panelUrl=session.url;}catch{/* сервера нет — запускаем */}
 if(!panelUrl){started=await detachServe(['serve','--state',statePath,...(flags.config?['--config',path.resolve(flags.config)]:[]),...(flags.node?['--node',path.resolve(flags.node)]:[])],{statePath,sessionPath,print:()=>{},deps,env});panelUrl=started.url;}
 const result={url:new URL('/setup',panelUrl).href,panelUrl,sessionPath,reused:!started||!!started.reused,...(started?.pid?{pid:started.pid,log:started.log}:{})};
 openBrowser?.(result.url);print(result);return result;
}
export async function main(args=process.argv.slice(2),options={}){
 const output=options.output||process.stdout,print=value=>output.write(typeof value==='string'?value+'\n':JSON.stringify(value,null,2)+'\n');const {command,flags}=parse(args);
 if(command==='help'){print(HELP);return {help:true};}
 const statePath=path.resolve(flags.state||options.statePath||path.join(defaultPaths().workRoot,'installer','state.json')),sessionPath=path.resolve(flags.session||statePath+'.session.json');
 const deps={createInstaller,startServer,acquireLease,readSession,...options.dependencies};
 if(command==='settings')return openSettings({flags,statePath,sessionPath,print,deps,env:options.env||process.env,openBrowser:options.openBrowser});
 if(!['start','serve','connect'].includes(command)){
  const session=await deps.readSession(sessionPath);const identity=await api(session,'/api/session',deps);if(identity.id!==session.id)throw fail('SESSION_CHANGED','Локальная сессия изменилась. Запустите serve заново.');
  if(command==='status'){const result=await api(session,'/api/state',deps);print(result);return result;}
  // Пока операция идёт, печатаем её ход в stderr понятными строками; итоговый JSON остаётся в stdout.
  const progressOutput=options.progressOutput||process.stderr,visible=createProgressFilter(),seen=new Set(),since=new Date().toISOString();let polls=0;
  const showProgress=async()=>{try{const state=await api(session,'/api/state',deps);for(const e of state.logs||[]){if(!(e.timestamp>=since))continue;const key=[e.timestamp,e.tool,e.operation,e.status,e.loaded,e.done,e.elapsed].join('|');if(seen.has(key))continue;seen.add(key);const text=describeEvent(e);if(text&&visible(e))progressOutput.write(text+'\n');}}catch{/* ход установки необязателен */}};
  let result=await api(session,'/api/command',{...deps,method:'POST',body:{command,args:commandArgs(command,flags)}});const id=result.id;
  while(result.status==='running'){await (deps.delay||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))))(200);if(++polls%5===0)await showProgress();result=await api(session,'/api/operation?id='+encodeURIComponent(id),deps);}
  await showProgress();
  if(result.status==='error')throw fail(result.error.code,result.error.message);print(result.result);return result.result;
 }
 const env=options.env||process.env;
 if(command==='serve'&&flags.detach)return detachServe(args,{statePath,sessionPath,print,deps,env});
 if(options.cleanupTemp)await cleanupStartPanels();
 let lease;try{lease=await deps.acquireLease(statePath,{recover:!!flags.recover});}catch(e){if(e.code==='OWNER_ACTIVE'){const session=await deps.readSession(sessionPath);await guarded(statePath+'.owner.json');const owner=JSON.parse(await readFile(statePath+'.owner.json','utf8'));if(!validOwner(owner,statePath)||session.owner!==owner.owner||session.pid!==owner.pid)throw fail('SESSION_CHANGED','Владелец сессии изменился.');const identity=await api(session,'/api/session',deps);if(identity.id!==session.id)throw fail('SESSION_CHANGED','Владелец сессии изменился.');const reused={url:session.url,sessionPath,id:session.id,nodePath:process.execPath,reused:true};print(reused);return reused;}throw e;}
 let engine,server,closing,descriptorWritten=false,resolveClosed;const closed=new Promise(resolve=>resolveClosed=resolve);
 const close=()=>closing||= (async()=>{try{await engine?.close();}finally{try{await server?.close();}finally{try{if(descriptorWritten){await guarded(sessionPath);const s=JSON.parse(await readFile(sessionPath,'utf8'));if(s.owner===lease.owner.owner)await unlink(sessionPath);}}finally{await lease.release();if(options.cleanupTemp)await cleanupStartPanels({current:env.TRANSCRIBE_BOOTSTRAP_HANDOFF||null});resolveClosed();}}}})();
 try{
  engine=await deps.createInstaller({...options.engineOptions,statePath,...(flags.config?{configPath:path.resolve(flags.config)}:{}),...(flags.node?{tools:{...options.engineOptions?.tools,node:path.resolve(flags.node)}}:{})});server=await deps.startServer(engine,{onShutdown:close});
  await guarded(sessionPath);await writeFile(sessionPath,JSON.stringify({version:1,url:server.url,capability:server.capability,id:engine.snapshot().id,owner:lease.owner.owner,pid:process.pid}),{mode:0o600});descriptorWritten=true;
  if(flags.open){
   options.openBrowser?.(server.url);
   // После установки мастер открывает страницу настроек, если сервис ещё не подключён.
   let setupOpened=false;engine.subscribe?.(event=>{if(!setupOpened&&event.stage==='install'&&['installed','updated'].includes(event.status)&&!['done','skipped'].includes(engine.snapshot().stages?.provider)){setupOpened=true;options.openBrowser?.(server.url+'/setup');}});
  }
  if(env.TRANSCRIBE_BOOTSTRAP_HANDOFF){
   try{const update=deps.updateBootstrapPanel||(await import('../lib/installer/bootstrap.mjs')).updateBootstrapPanel;await update(env.TRANSCRIBE_BOOTSTRAP_HANDOFF,{operation:'Node.js готов. Мастер установки запущен.',url:new URL(server.url).href,nodeStatus:'готов'});}
   catch{print(`Предупреждение: не удалось обновить начальную HTML-панель. Мастер продолжает работу. Основная панель: ${server.url}`);}
  }
  // JSON сессии нужен только ассистенту в чате (serve); в терминале он лишь мешает.
  const result={url:server.url,sessionPath,id:engine.snapshot().id,nodePath:process.execPath};
  if(command==='serve'){print(result);return {...result,close,closed};}
  const run=deps.runTerminal||(await import('../lib/installer/terminal.mjs')).runTerminal;try{return await run(engine,{input:options.input||process.stdin,output,url:server.url,openBrowser:env.TRANSCRIBE_BOOTSTRAP_HANDOFF?undefined:options.openBrowser,connect:command==='connect'});}finally{await close();}
 }catch(e){await close();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const logFile=process.env[serveLogVariable];
 if(logFile){const {appendFileSync}=await import('node:fs');for(const stream of [process.stdout,process.stderr])stream.write=(chunk,...rest)=>{try{appendFileSync(logFile,chunk);}catch{/* журнал недоступен */}rest.find(item=>typeof item==='function')?.();return true;};}
 try{const runtime=await main(process.argv.slice(2),{openBrowser:openUrl,cleanupTemp:true});if(runtime?.close)await new Promise(resolve=>{let stopping=false;const cleanup=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);resolve();};const stop=async()=>{if(stopping)return;stopping=true;try{await runtime.close();}catch{process.exitCode=1;}finally{cleanup();}};process.on('SIGINT',stop);process.on('SIGTERM',stop);runtime.closed.then(cleanup);});}
 catch(e){process.stderr.write((e.installerSafe?e.message:fileSystemError(e)?.message??'Мастер не запущен безопасно. Проверьте путь и права.')+'\n');process.exitCode=1;}
}
