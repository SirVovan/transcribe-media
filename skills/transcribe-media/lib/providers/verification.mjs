import {getProviderKey,getCredentialRevision,setProviderKey} from '../config/index.mjs';
// One free request without audio. The body is never read: AssemblyAI lists the user's latest job there.
const endpoints={deepgram:{url:'https://api.deepgram.com/v1/auth/token',authorization:key=>`Token ${key}`},assemblyai:{url:'https://api.assemblyai.com/v2/transcript?limit=1',authorization:key=>key}};
const refused=['rejected','insufficient-permissions','cancelled'];
export async function checkKey({provider,key,fetchImpl=fetch,signal,timeoutMs=10000}={}) {
 const checkedAt=new Date().toISOString();
 const result=status=>({status,safeCode:status,checkedAt});
 const endpoint=endpoints[provider];
 if(!endpoint)return result('inconclusive');
 if(signal?.aborted)return result('cancelled');
 if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>30000)return result('inconclusive');
 const controller=new AbortController();let timedOut=false;const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 let settle;const interrupted=new Promise(resolve=>settle=resolve);controller.signal.addEventListener('abort',()=>settle(result(timedOut?'network-error':'cancelled')),{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
 try {
  return await Promise.race([interrupted,(async()=>{try {
   const response=await fetchImpl(endpoint.url,{method:'GET',headers:{Authorization:endpoint.authorization(key)},redirect:'error',signal:controller.signal});
   const status=response?.status;response?.body?.cancel?.().catch?.(()=>{});
   if(response?.redirected||response?.url&&response.url!==endpoint.url)return result('inconclusive');
   return result(Number.isInteger(status)&&status>=200&&status<300?'confirmed':status===401?'rejected':status===403?'insufficient-permissions':status===429?'rate-limited':status>=500&&status<600?'unavailable':'inconclusive');
  }catch{return result(controller.signal.aborted?(timedOut?'network-error':'cancelled'):'network-error');}})()]);
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function verifyProviderAccess({provider,credentialsFile,fetchImpl=fetch,signal,timeoutMs=10000,allowNetwork=false,env=process.env}={}) {
 const checkedAt=new Date().toISOString();let credentialRevision=null;
 const result=status=>({status,safeCode:status,checkedAt,credentialRevision});
 if(!endpoints[provider])return result('inconclusive');
 if(!allowNetwork)return result('unverified');
 if(signal?.aborted)return result('cancelled');
 let key;
 try {credentialRevision=await getCredentialRevision(provider,{credentialsFile,env});key=await getProviderKey(provider,{credentialsFile,env});}catch{return result('inconclusive');}
 return {...await checkKey({provider,key,fetchImpl,signal,timeoutMs}),credentialRevision};
}
// Pressing «Сохранить и проверить» is the consent to this request. A key refused by the
// service (401/403) is never written; an unreachable service leaves it saved but unverified.
export async function saveCheckedKey({provider,key,credentialsFile,fetchImpl=fetch,signal,timeoutMs=10000}={}) {
 if(!endpoints[provider])throw Object.assign(new Error('Неизвестный провайдер.'),{code:'INVALID_PROVIDER'});
 const value=typeof key==='string'?key.trim():'';
 if(!value||value.length>8192||/[\r\n\x00]/.test(value))throw Object.assign(new Error('Вставьте ключ одной строкой.'),{code:'KEY_INVALID'});
 const checked=await checkKey({provider,key:value,fetchImpl,signal,timeoutMs});
 if(refused.includes(checked.status))return {saved:false,...checked};
 await setProviderKey(provider,value,{credentialsFile});
 return {saved:true,...checked,credentialRevision:await getCredentialRevision(provider,{credentialsFile,env:{}})};
}
