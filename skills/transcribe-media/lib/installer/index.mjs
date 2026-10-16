import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { installPackage, inspectDependencies, describePlan } from '../install/index.mjs';
import { resolveConfig, saveConfig, defaultPaths, providerStatus, getCredentialRevision, removeProviderKey, readHiddenKey } from '../config/index.mjs';
import { createSettings, restoreConnection } from './service.mjs';
import { verifyProviderAccess, saveCheckedKey } from '../providers/verification.mjs';
import { validateRecognition, canonicalModel, providerCapabilities } from '../providers/index.mjs';
import { fileSystemError } from '../errors.mjs';

const clone = value => structuredClone(value);
const error = (code,message) => Object.assign(new Error(message),{code,installerSafe:true});
const names=['node','ffmpeg','ffprobe','ytdlp'];
const selectionKeys=['agent','scope','projectRoot','inPlace'];
const settingKeys=['language','interval','formats','diarize','speakerCount','outputRoot'];
function safe(value) {
  if(Array.isArray(value))return value.map(safe);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>['credentialStatus','credentialRevision','obtainKey'].includes(k)||!/(?:secret|token|key|credentials|cookies|stdout|stderr)/i.test(k)).map(([k,v])=>[k,safe(v)]));
  return value;
}
function pick(value,keys) { if(!value || typeof value!=='object' || Array.isArray(value))throw error('INVALID_INPUT','Ожидается объект параметров.');for(const k of Object.keys(value))if(!keys.includes(k))throw error('INVALID_INPUT','Неизвестный параметр.');return clone(value); }
// inPlace: скилл уже поставлен из GitHub (/plugin install, npx skills add, установщик Codex) — мастер ставит только программы и настройки.
function validateSelection(s) {if(s.inPlace!==undefined){if(s.inPlace!==true||Object.keys(s).length!==1)throw error('INVALID_SELECTION','Режим «скилл уже на месте» не сочетается с выбором клиента и области.');return;}if(!['codex','claude','both'].includes(s.agent)||!['user','project'].includes(s.scope))throw error('INVALID_SELECTION','Выберите клиент и область установки.');if(s.scope==='project' && (typeof s.projectRoot!=='string'||!path.isAbsolute(s.projectRoot)))throw error('INVALID_SELECTION','Укажите абсолютный путь проекта.');}
function validateSettings(s) {
  if(typeof s.language!=='string'||!s.language.trim()||!Number.isFinite(s.interval)||s.interval<=0)throw error('INVALID_SETTINGS','Выберите язык и положительную длину субтитра.');
  if(!Array.isArray(s.formats)||!s.formats.length||s.formats.some(f=>!['txt','srt','vtt'].includes(f)))throw error('INVALID_SETTINGS','Выберите TXT, SRT или VTT.');
  if(typeof s.diarize!=='boolean'||s.speakerCount!=='auto'&&(!Number.isInteger(s.speakerCount)||s.speakerCount<1))throw error('INVALID_SETTINGS','Проверьте настройки участников.');
  if(typeof s.outputRoot!=='string'||!path.isAbsolute(s.outputRoot))throw error('INVALID_SETTINGS','Укажите абсолютный путь результата.');
}
async function guarded(file) {let p=path.parse(file).root;for(const part of file.slice(p.length).split(path.sep).filter(Boolean)){p=path.join(p,part);try{const s=await lstat(p);if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw error('STATE_PATH','Ссылки в пути состояния запрещены.');}catch(e){if(e.code!=='ENOENT')throw e;}}}

export async function createInstaller(options={}) {
  const deps={installPackage,inspectDependencies,resolveConfig,saveConfig,providerStatus,getCredentialRevision,removeProviderKey,readHiddenKey,verifyProviderAccess,saveCheckedKey,...options.dependencies};
  const statePath=path.resolve(options.statePath||path.join(defaultPaths().workRoot,'installer','state.json'));
  const listeners=new Set();let busy=false,closed=false,cancelled=false,cancellation=null,writeQueue=Promise.resolve();
  let state={id:randomUUID(),updatedAt:new Date().toISOString(),stages:{select:'pending',inspect:'pending',install:'pending',provider:'pending',configure:'pending',finish:'pending'},tools:Object.fromEntries(names.map(n=>[n,{status:'unknown',version:null}])),youtube:{status:'unknown',ejs:'unknown',nodeRuntime:'unknown'},operation:null,awaiting:'selection',logs:[],selection:{},settings:{formats:['txt','srt','vtt'],diarize:false,speakerCount:'auto'},result:{},connection:restoreConnection()};
  await guarded(statePath);
  try {const old=JSON.parse(await readFile(statePath,'utf8'));if(!old||typeof old.id!=='string'||!old.stages||!old.settings||!old.selection)throw error('STATE_INVALID','Некорректное состояние мастера.');if(old.stages.select==="done")validateSelection(old.selection);if(old.stages.configure==='done')validateSettings(old.settings);const {serviceOnboarding,...current}=safe(old);state={...state,...current,tools:{...state.tools,...safe(old.tools)},connection:restoreConnection(current.connection,serviceOnboarding)};if(state.operation){state.operation=null;state.awaiting='resume';state.result={...state.result,interrupted:true};state.stages.install=state.stages.install==='running'?'interrupted':state.stages.install;}}
  catch(e){if(e.code!=='ENOENT')throw error('STATE_INVALID','Не удалось безопасно восстановить состояние мастера.');}
  const configOptions={configPath:options.configPath,projectConfigPath:options.projectConfigPath};
  try {
    let config;
    try {config=await deps.resolveConfig(configOptions);}
    catch(e){
      if(e.code==='ENOENT')config={};
      else throw e;
    }
    state.settings={...state.settings,...Object.fromEntries(settingKeys.filter(k=>config[k]!==undefined).map(k=>[k,config[k]]))};options.tools={...config.tools,...options.tools};
  }catch{throw error('CONFIG_INVALID','Не удалось прочитать настройки мастера. Проверьте существующий JSON и параметры конфигурации.');}
  const snapshot=()=>clone(safe(state));
  async function persist(){const content=JSON.stringify(safe(state),null,2);const write=writeQueue.catch(()=>{}).then(async()=>{await guarded(statePath);await mkdir(path.dirname(statePath),{recursive:true});const temp=statePath+'.'+randomUUID()+'.tmp';await writeFile(temp,content,{flag:'wx',mode:0o600});await guarded(statePath);await rename(temp,statePath);});writeQueue=write;return write;}
  async function emit(event){const e={stage:event.stage||state.operation||'wizard',operation:event.operation||state.operation||'state',status:event.status||'done',timestamp:new Date().toISOString(),...safe(event)};state.updatedAt=e.timestamp;
    // Прогресс одной загрузки или копирования занимает одну строку журнала, а не сотни.
    const last=state.logs.at(-1),measured=x=>Number.isFinite(x?.loaded)||Number.isFinite(x?.done)||Number.isFinite(x?.elapsed);
    state.logs=measured(e)&&measured(last)&&last.tool===e.tool&&last.operation===e.operation?[...state.logs.slice(0,-1),e]:[...state.logs,e].slice(-100);await persist();for(const listener of listeners){try{listener(clone(e),snapshot());}catch{/* Ошибка отображения не меняет установку. */}}}
  async function run(name,fn){
    if(closed)throw error('CLOSED','Мастер закрыт.');if(busy)throw error('BUSY','Другая операция ещё выполняется.');busy=true;state.operation=name;
    if(!name.startsWith('service-'))delete state.result.error;
    try{const result=await fn();if(result?.id===state.id)result.operation=null;return result;}
    catch(e){if(name==='install'&&state.stages.install==='running')state.stages.install='error';const system=e.installerSafe?null:fileSystemError(e),code=system?.code??(/^[A-Z_]+$/.test(e.code||'')?e.code:'INSTALLER_ERROR'),message=e.installerSafe?e.message:system?.message??'Операция не выполнена. Исправьте параметры и повторите.';if(!name.startsWith('service-'))state.result.error={stage:name,code,message};await emit({stage:name,status:'error',message});throw error(code,message);}
    finally{state.operation=null;busy=false;await persist();}
  }
  // Язык проверяется для основного сервиса и его модели (находка 5 ревью: раньше принималась любая строка).
  async function checkLanguage(language){
    let config={};try{config=await deps.resolveConfig(configOptions);}catch{/* проверяем по сервису по умолчанию */}
    const provider=providerCapabilities[config.provider]?config.provider:'deepgram';
    try{validateRecognition({provider,model:canonicalModel(provider,config.providers?.[provider]?.model??config.model??providerCapabilities[provider].defaultModel),language});}
    catch{throw error('INVALID_SETTINGS','Основной сервис не поддерживает этот язык. Выберите «Определять автоматически» или другой язык.');}
  }
  const installOptions=()=>({...options,dependencies:undefined,statePath:undefined,configPath:undefined,env:undefined,fetchImpl:undefined,...state.selection,tools:options.tools});
  const engine={snapshot,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    select(patch){return run('select',async()=>{const next=pick(patch,selectionKeys),selection=next.inPlace?next:{...(state.selection.inPlace?{}:state.selection),...next};validateSelection(selection);state.selection=selection;state.stages.select='done';state.stages.inspect='pending';state.stages.install='pending';state.stages.finish='pending';state.result={};state.awaiting='check';cancelled=false;cancellation=null;await emit({stage:'select'});return snapshot();});},
    inspect({allowCheck=false}={}){return run('inspect',async()=>{if(!allowCheck)throw error('CHECK_CONSENT','Проверка программ требует согласия.');validateSelection(state.selection);const inspected=await deps.inspectDependencies({...installOptions(),onProgress:e=>emit(e)});state.tools=safe(inspected.tools);state.youtube=safe(inspected.youtube);state.result.inspection=safe(inspected);state.stages.inspect='done';state.awaiting='plan';await emit({stage:'inspect'});return snapshot();});},
    plan(){return run('plan',async()=>{validateSelection(state.selection);if(state.stages.inspect!=='done')throw error('CHECK_REQUIRED','Сначала разрешите проверку программ.');const p=await deps.installPackage({...installOptions(),inspection:state.result.inspection,dryRun:true,allowInstall:false});state.result.plan=safe(p.plan);state.result.planSteps=describePlan(p.plan);state.result.planWarnings=safe(p.warnings||[]);state.result.targets=safe(p.targets);state.result.planId=createHash('sha256').update(JSON.stringify({selection:state.selection,plan:p.plan,tools:state.tools})).digest('hex');state.awaiting='install';await emit({stage:'install',status:'planned'});return snapshot();});},
    install({allowInstall=false,update=false,planId}={}){if(state.stages.install==='done')return Promise.resolve(snapshot());if(busy&&state.operation==='install')return installation;const task=run('install',async()=>{if(!allowInstall)throw error('INSTALL_CONSENT','Установка требует согласия.');if(!planId||planId!==state.result.planId||state.awaiting!=='install')throw error('PLAN_CHANGED','Подтвердите актуальный план установки.');const current=await deps.installPackage({...installOptions(),inspection:state.result.inspection,dryRun:true,allowInstall:false});const currentId=createHash("sha256").update(JSON.stringify({selection:state.selection,plan:current.plan,tools:state.tools})).digest("hex");if(currentId!==planId){state.result.plan=safe(current.plan);state.result.planSteps=describePlan(current.plan);state.result.planId=currentId;state.result.targets=safe(current.targets);throw error("PLAN_CHANGED","Подтвердите изменившийся план установки.");}cancellation=null;cancelled=false;state.stages.install='running';await emit({stage:'install',status:'running'});const p=await deps.installPackage({...installOptions(),inspection:state.result.inspection,allowInstall:true,update,onProgress:e=>emit(e)});state.result.install=safe(p);const confirmed=p.dependencies||p.inspection;if(confirmed?.tools)state.tools=safe(confirmed.tools);if(confirmed?.youtube)state.youtube=safe(confirmed.youtube);if(confirmed)state.result.inspection=safe(confirmed);if(p.tools&&['installed','updated'].includes(p.status)){await deps.saveConfig({configPath:options.configPath,patch:{tools:p.tools}});options.tools=p.tools;}state.stages.install=['installed','updated'].includes(p.status)?'done':p.status;state.awaiting=cancelled?'resume':state.stages.install==='done'?(['done','skipped'].includes(state.stages.provider)?'settings':'provider'):p.status==='existing'?'update':p.status==='manual-required'?'manual':'install';await emit({stage:'install',status:p.status});return snapshot();});installation=task;return task;},
    configure(settings){return run('configure',async()=>{const next={...state.settings,...pick(settings,settingKeys)};validateSettings(next);await checkLanguage(next.language);await deps.saveConfig({configPath:options.configPath,patch:{...next,...(options.tools?{tools:options.tools}:{})}});state.settings=next;state.stages.configure='done';state.awaiting=state.stages.finish==='done'?null:'finish';await emit({stage:'configure'});return snapshot();});},
    skipProvider(){return run('provider',async()=>{if(state.stages.provider==='done')return snapshot();state.stages.provider='skipped';state.awaiting='settings';await emit({stage:'provider',status:'skipped'});return snapshot();});},
    finish(){return run('finish',async()=>{if(state.stages.install!=='done'||state.stages.configure!=='done'||!['done','skipped'].includes(state.stages.provider))throw error('INCOMPLETE','Завершите установку, подключение или пропуск сервиса и настройки.');state.stages.finish='done';state.awaiting=null;state.result.nextRequest='Попросите транскрибировать файл или ссылку; облачная отправка требует отдельного согласия.';await emit({stage:'finish'});return snapshot();});},
    cancel(){
      if(cancellation)return cancellation;
      cancelled=true;
      const active=busy&&state.operation==='install'?installation:null;
      state.awaiting=active?'cancel-pending':'resume';
      cancellation=(async()=>{
        if(active){
          await emit({stage:'wizard',status:'cancel-pending',message:'Ожидается безопасное завершение текущей установки.'});
          // Ошибка остаётся на Promise установки и в её безопасном событии; отмена ждёт settlement.
          await active.then(()=>undefined,()=>undefined);
        }
        state.awaiting='resume';
        await emit({stage:'wizard',status:'cancelled',message:'Мастер приостановлен, установленное сохранено. Чтобы продолжить, запустите установку снова — мастер продолжит с этого места.'});
        return snapshot();
      })();
      return cancellation;
    },
    async close(){
      if(busy&&state.operation==='install'||cancellation)await engine.cancel();
      closed=true;listeners.clear();await persist();return snapshot();
    }
  };let installation;
  Object.assign(engine,createSettings({state,options,deps,run,emit,snapshot}));
  return engine;
}
