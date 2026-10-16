import {providerGuides,allowedLinkHosts,checkNotice,keyResultText,verificationText} from '/provider-guides.mjs';
const $=id=>document.getElementById(id);
const capability=document.querySelector('meta[name="settings-capability"]')?.content;
const order=['deepgram','assemblyai'],envNames={deepgram:'DEEPGRAM_API_KEY',assemblyai:'ASSEMBLYAI_API_KEY'};
let state=null,languages=[],busy=false;const messages={};
const languageName=code=>{try{const name=new Intl.DisplayNames(['ru'],{type:'language'}).of(code);return name&&name!==code?name[0].toUpperCase()+name.slice(1):code;}catch{return code;}};
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function link(href,label){try{const url=new URL(href);if(url.protocol!=='https:'||!allowedLinkHosts.includes(url.hostname))return node('span',label);const a=node('a',label);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return node('span',label);}}
function badge(text,kind){return node('span',text,'badge '+kind);}
function button(text,cls,action){const b=node('button',text,cls);b.type='button';b.disabled=busy;b.addEventListener('click',action);return b;}
async function call(body){
 const response=await fetch('/api/settings',{method:'POST',headers:{authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify(body)});
 const value=await response.json().catch(()=>null);
 if(!response.ok)throw Error(value?.error?.message||value?.error||'Действие не выполнено.');
 return value;
}
async function act(provider,body,{clearInput=false}={}){
 if(busy)return;busy=true;if(provider)messages[provider]={text:body.action==='save-key'?'Проверяем ключ…':'Выполняется…',kind:'info'};render();
 try{const result=await call(body);state=result;if(provider)messages[provider]=result.keyResult?{text:keyResultText(result.keyResult),kind:result.keyResult.saved?(result.keyResult.status==='confirmed'?'ok':'warn'):'fail'}:{text:'Готово.',kind:'ok'};if(clearInput&&result.keyResult?.saved)inputs[provider]='';}
 catch(error){if(provider)messages[provider]={text:error.message,kind:'fail'};}
 finally{busy=false;render();}
}
const inputs={};
function verificationBadges(entry){
 if(entry.credential==='missing')return [badge('ключ не задан','fail')];
 const result=[];if(entry.credential==='env')result.push(badge('ключ задан переменной окружения','info'));
 const v=entry.verification;
 if(v.status==='confirmed')result.push(badge(verificationText(v).replace(/^Ключ проверен/,'ключ проверен').replace(/\.$/,''),'ok'));
 else if(['rejected','insufficient-permissions'].includes(v.status))result.push(badge('ключ отклонён','fail'));
 else result.push(badge(entry.credential==='env'?'ключ не проверен':'ключ сохранён, не проверен','warn'));
 return result;
}
function card(provider){
 const guide=providerGuides[provider],entry=state.connection.providers[provider],primary=state.connection.primary===provider,verified=entry.credential!=='missing'&&entry.verification.status==='confirmed';
 const el=node('section',undefined,'card');el.setAttribute('aria-label',guide.title);
 const head=node('div',undefined,'card-head');head.append(node('h2',guide.title));if(primary)head.append(badge('основной','active'));head.append(...verificationBadges(entry));el.append(head);
 const steps=node('ol',undefined,'steps');
 const step=(number,done,...content)=>{const li=node('li');li.append(node('span',done?'✓':String(number),'step-mark'+(done?' done':'')));const body=node('div');body.append(...content);li.append(body);steps.append(li);};
 step(1,false,node('b','Регистрация: '),link(guide.signupUrl,'открыть страницу регистрации'));
 const hint=node('span','В кабинете: '+guide.keyHint,'hint');step(2,false,node('b','Создать ключ: '),link(guide.keyUrl,'открыть кабинет'),hint);
 const input=node('input');input.type='password';input.autocomplete='off';input.spellcheck=false;input.placeholder=entry.credential==='missing'?'Вставьте ключ':'Вставьте новый ключ, чтобы заменить';input.setAttribute('aria-label','Ключ '+guide.title);input.maxLength=8192;input.value=inputs[provider]||'';input.addEventListener('input',()=>{inputs[provider]=input.value;});
 const save=button('Сохранить и проверить','',()=>{const key=input.value.trim();if(!key){messages[provider]={text:'Вставьте ключ.',kind:'fail'};render();return;}act(provider,{action:'save-key',provider,key},{clearInput:true});});
 input.addEventListener('keydown',event=>{if(event.key==='Enter')save.click();});
 const row=node('div',undefined,'key-row');row.append(input,save);
 const third=[node('b','Вставить ключ'),row,node('p',checkNotice,'notice')];
 if(entry.credential==='env')third.push(node('p',`Сейчас используется ключ из переменной окружения ${envNames[provider]}: она важнее ключа, сохранённого здесь.`,'notice'));
 step(3,verified,...third);el.append(steps);
 if(messages[provider])el.append(node('p',messages[provider].text,'message '+messages[provider].kind));
 const actions=node('div',undefined,'actions');
 if(entry.credential!=='missing')actions.append(button('Проверить снова','secondary',()=>act(provider,{action:'verify',provider})));
 if(entry.credential!=='missing'&&!primary)actions.append(button('Сделать основным','secondary',()=>act(provider,{action:'primary',provider})));
 if(entry.credential==='saved')actions.append(button('Удалить ключ','danger',()=>{if(confirm(`Удалить сохранённый ключ ${guide.title}? Его придётся вставить заново.`))act(provider,{action:'remove-key',provider});}));
 if(actions.childNodes.length)el.append(actions);
 const details=node('details');details.append(node('summary','Подробная инструкция'));const list=node('ol');for(const text of [...guide.registration,...guide.obtainKey])list.append(node('li',text));details.append(list,node('p',guide.help));el.append(details);
 const links=node('div',undefined,'links');links.append(link(guide.consoleUrl,'Кабинет'),link(guide.pricingUrl,'Цены'),link(guide.docsUrl,'Справка API'));el.append(links);
 return el;
}
function renderOverall(){
 const c=state.connection,title=providerGuides[c.primary].title,entry=c.providers[c.primary];
 $('overall-badge').textContent=c.ready?'Готово':'Нужна настройка';$('overall-badge').className='badge '+(c.ready?'ok':'warn');
 $('overall-title').textContent=c.ready?'Можно расшифровывать':'Нужна настройка';
 $('overall-note').textContent=c.ready?`Основной сервис — ${title}, ключ проверен.`:entry.credential==='missing'?`У основного сервиса (${title}) нет ключа. Сохраните ключ ниже.`:`Ключ основного сервиса (${title}) не проверен. Нажмите «Проверить снова».`;
}
let settingsFilled=false;
function renderSettings(){
 const s=state.settings||{},primary=state.connection.primary;
 if(!settingsFilled){
  const select=$('language');select.replaceChildren();const add=(value,label)=>{const option=node('option',label);option.value=value;select.append(option);};
  add('auto','Определять автоматически');const codes=[...languages];if(s.language&&s.language!=='auto'&&!codes.includes(s.language))codes.unshift(s.language);
  for(const code of codes)add(code,`${languageName(code)} (${code})`);select.value=s.language||'auto';
  $('interval').value=s.interval??30;for(const box of document.querySelectorAll('input[name="formats"]'))box.checked=(s.formats||['txt','srt','vtt']).includes(box.value);
  $('diarize').checked=!!s.diarize;const speakers=$('speakers');for(let n=1;n<=10;n++){const option=node('option',String(n));option.value=String(n);speakers.append(option);}speakers.value=String(s.speakerCount??'auto');
  $('output').value=s.outputRoot||'';settingsFilled=true;
 }
 $('speakers-field').hidden=!($('diarize').checked&&primary==='assemblyai');
 $('diarize-note').textContent=providerGuides[primary].diarization;
 $('save-settings').disabled=busy;
}
function render(){
 if(!state)return;renderOverall();
 $('providers').replaceChildren(...order.map(card));renderSettings();
}
$('diarize').addEventListener('change',()=>state&&renderSettings());
$('settings-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;
 const formats=[...document.querySelectorAll('input[name="formats"]:checked')].map(box=>box.value),speakers=$('speakers').value;
 const settings={language:$('language').value,interval:Number($('interval').value),formats,diarize:$('diarize').checked,speakerCount:speakers==='auto'?'auto':Number(speakers),outputRoot:$('output').value.trim()};
 const message=$('settings-message');
 if(!formats.length){message.textContent='Выберите хотя бы один формат.';message.className='message fail';return;}
 busy=true;render();message.textContent='Сохраняем…';message.className='message info';
 try{state=await call({action:'configure',settings});message.textContent='Настройки сохранены.';message.className='message ok';}
 catch(error){message.textContent=error.message;message.className='message fail';}
 finally{busy=false;render();}
});
async function load(){
 if(!capability){$('connection').textContent='Откройте страницу по ссылке, которую дал ассистент или команда настроек.';$('connection').className='stale';return;}
 try{const result=await call({action:'refresh'});languages=result.languages||[];state=result;render();$('connection').textContent='Связь с сервером настроек есть.';}
 catch(error){$('connection').textContent=error.message;$('connection').className='stale';}
}
async function heartbeat(){try{const response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error();$('connection').textContent='Связь с сервером настроек есть.';$('connection').className='';}catch{$('connection').textContent='Сервер настроек выключен. Откройте страницу заново из чата: попросите ассистента открыть настройки.';$('connection').className='stale';}finally{setTimeout(heartbeat,10000);}}
await load();setTimeout(heartbeat,10000);
