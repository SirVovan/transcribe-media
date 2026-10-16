import {commonLanguages} from '../providers/index.mjs';
import {providerGuides,keyResultText} from './provider-guides.mjs';

const providers=['deepgram','assemblyai'];
const envNames={deepgram:'DEEPGRAM_API_KEY',assemblyai:'ASSEMBLYAI_API_KEY'};
const statuses=new Set(['unverified','confirmed','rejected','insufficient-permissions','rate-limited','unavailable','network-error','inconclusive']);
const error=(code,message)=>Object.assign(new Error(message),{code,installerSafe:true});
const unverified=credentialRevision=>({status:'unverified',checkedAt:null,credentialRevision});
const text=value=>typeof value==='string'?value:null;
function verificationFrom(value){return value&&statuses.has(value.status)?{status:value.status,checkedAt:text(value.checkedAt),credentialRevision:text(value.credentialRevision)}:unverified(null);}
function providerName(provider){if(!providers.includes(provider))throw error('INVALID_PROVIDER','Выберите Deepgram или AssemblyAI.');return provider;}

// Состояние подключения: основной сервис, источник ключа и проверка по каждому сервису. Сам ключ здесь не хранится.
// Из старого пошагового мастера (serviceOnboarding, schemaVersion 1) переносится только подтверждённая проверка.
export function restoreConnection(saved,legacy){
 const connection={primary:providers.includes(saved?.primary)?saved.primary:'deepgram',ready:false,providers:{}};
 for(const provider of providers){const entry=saved?.providers?.[provider];connection.providers[provider]={credential:['saved','env'].includes(entry?.credential)?entry.credential:'missing',verification:verificationFrom(entry?.verification)};}
 const old=legacy?.verification;
 if(!saved&&legacy?.schemaVersion===1&&providers.includes(legacy.provider)&&old?.status==='confirmed'&&typeof old.credentialRevision==='string')connection.providers[legacy.provider].verification=verificationFrom(old);
 return connection;
}

export function createSettings({state,options,deps,run,emit,snapshot}){
 const keyOptions={credentialsFile:options.credentialsFile};
 const configOptions={configPath:options.configPath,projectConfigPath:options.projectConfigPath};
 const env=options.env||process.env;
 const network=options.fetchImpl?{fetchImpl:options.fetchImpl}:{};
 const connection=()=>state.connection;
 async function refresh(){
  let config={};try{config=await deps.resolveConfig(configOptions);}catch{/* Повреждённые настройки покажет сохранение. */}
  connection().primary=providers.includes(config.provider)?config.provider:'deepgram';
  const saved=await deps.providerStatus({...keyOptions,...configOptions});
  for(const provider of providers){
   const entry=connection().providers[provider];
   entry.credential=env[envNames[provider]]?.trim()?'env':saved[provider]?.saved?'saved':'missing';
   // Проверка относится к тому ключу, на котором выполнялась: после замены ключа она сбрасывается.
   const revision=entry.credential==='missing'?null:await deps.getCredentialRevision(provider,{...keyOptions,env});
   if(revision!==entry.verification.credentialRevision)entry.verification=unverified(revision);
  }
  const primary=connection().providers[connection().primary];
  connection().ready=primary.credential!=='missing'&&primary.verification.status==='confirmed';
  if(primary.credential!=='missing'&&state.stages.provider!=='done'){state.stages.provider='done';if(state.awaiting==='provider')state.awaiting='settings';}
 }
 async function saveKey(provider,key){
  let result;
  try{result=await deps.saveCheckedKey({provider,key,...keyOptions,...network});}
  catch(e){if(e.code==='KEY_INVALID')throw error('KEY_INVALID','Вставьте ключ одной строкой: без переводов строки, не длиннее 8192 символов.');throw e;}
  const keyResult={provider,saved:result.saved===true,status:result.status};
  if(keyResult.saved){
   connection().providers[provider].verification=verificationFrom({status:statuses.has(result.status)?result.status:'inconclusive',checkedAt:result.checkedAt,credentialRevision:result.credentialRevision});
   await deps.saveConfig({configPath:options.configPath,patch:{providers:{[provider]:{enabled:true}}}});
   await refresh();
   // Решение пользователя 15.10: если у основного сервиса ключа нет, основным становится сервис с новым ключом.
   if(connection().primary!==provider&&connection().providers[connection().primary].credential==='missing'){await deps.saveConfig({configPath:options.configPath,patch:{provider}});await refresh();}
  }else await refresh();
  await emit({stage:'provider',status:keyResult.saved?'saved':'error',message:`${providerGuides[provider].title}: ${keyResultText(keyResult)}`});
  return {...snapshot(),keyResult};
 }
 const methods={
  settingsRefresh(){return run('service-refresh',async()=>{await refresh();return {...snapshot(),languages:[...commonLanguages]};});},
  async settingsSaveKey({provider,key}={}){providerName(provider);return run('service-key',()=>saveKey(provider,key));},
  async providerKey({provider}={}){
   providerName(provider);let key;
   try{key=await deps.readHiddenKey();}
   catch(e){if(e.code==='INPUT_CANCELLED')return {...snapshot(),keyResult:{provider,saved:false,status:'cancelled'}};throw error('TTY_REQUIRED','Нужен интерактивный терминал. Введите ключ на странице настроек.');}
   return run('service-key',()=>saveKey(provider,key));
  },
  async settingsVerify({provider}={}){providerName(provider);return run('service-verify',async()=>{
   await refresh();if(connection().providers[provider].credential==='missing')throw error('KEY_REQUIRED','Сначала сохраните ключ этого сервиса.');
   const result=await deps.verifyProviderAccess({provider,...keyOptions,env,allowNetwork:true,...network});
   connection().providers[provider].verification=verificationFrom({...result,status:statuses.has(result?.status)?result.status:'inconclusive'});
   await refresh();return snapshot();
  });},
  async settingsRemoveKey({provider}={}){providerName(provider);return run('service-remove',async()=>{
   await refresh();const entry=connection().providers[provider];
   if(entry.credential==='env')throw error('KEY_FROM_ENV',`Ключ ${providerGuides[provider].title} задан переменной окружения ${envNames[provider]}. Скилл её не меняет: удалите переменную в настройках системы.`);
   if(entry.credential==='saved')await deps.removeProviderKey(provider,keyOptions);
   await refresh();return snapshot();
  });},
  async settingsPrimary({provider}={}){providerName(provider);return run('service-primary',async()=>{
   await refresh();if(connection().providers[provider].credential==='missing')throw error('KEY_REQUIRED','Сначала сохраните ключ этого сервиса.');
   await deps.saveConfig({configPath:options.configPath,patch:{provider,providers:{[provider]:{enabled:true}}}});
   await refresh();return snapshot();
  });}
 };
 return methods;
}
