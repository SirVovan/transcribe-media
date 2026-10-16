import path from 'node:path';
import {describeEvent,createProgressFilter} from './progress-text.mjs';
import {checkNotice,keyResultText} from './provider-guides.mjs';
// Строки ответов читаются своим обработчиком, а не readline: на время скрытого ввода ключа его можно снять,
// и символы ключа не попадут в очередь обычных ответов.
function lineReader(input){
  let buffer='',ended=false,waiting=null;const lines=[];
  const deliver=()=>{if(!waiting)return;if(lines.length){const resolve=waiting;waiting=null;resolve({value:lines.shift(),done:false});}else if(ended){const resolve=waiting;waiting=null;resolve({value:undefined,done:true});}};
  const onData=chunk=>{buffer+=String(chunk);for(let match;(match=/\r?\n/.exec(buffer));){lines.push(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}deliver();};
  const onEnd=()=>{if(buffer){lines.push(buffer);buffer='';}ended=true;deliver();};
  const attach=()=>{input.on('data',onData);input.resume?.();};
  const detach=()=>{input.off('data',onData);input.pause?.();};
  input.on('end',onEnd);attach();
  return {next:()=>new Promise(resolve=>{waiting=resolve;deliver();}),attach,detach,close(){detach();input.off('end',onEnd);}};
}
export async function runTerminal(engine,{input=process.stdin,output=process.stdout,url,openBrowser,connect=false}={}) {
  const lines=lineReader(input);
  const say=value=>output.write(String(value)+'\n');
  const ask=async(question,validate=v=>Boolean(v))=>{for(;;){say(question);const {value,done}=await lines.next();if(done)throw Object.assign(new Error('Ввод завершён. Настройки сохранены; запустите мастер снова.'),{code:'INPUT_CLOSED'});const answer=value.trim();if(/^(отмена|cancel|выход)$/i.test(answer))throw Object.assign(new Error('Мастер остановлен. Установленное сохранено.'),{code:'CANCELLED'});if(validate(answer))return answer;say('Введите один из указанных вариантов.');}};
  const yes=async q=>/^(да|yes|y|1)$/i.test(await ask(q+' (да/нет)',v=>/^(да|yes|y|1|нет|no|n|2)$/i.test(v)));
  const normalize=v=>v.toLowerCase()==='claude code'?'claude':v.toLowerCase()==='both'?'оба':v.toLowerCase();
  const choice=async(q,values)=>{const a=await ask(q,v=>values.some((x,i)=>normalize(v)===x||v===String(i+1)));return values.find((x,i)=>normalize(a)===x||a===String(i+1));};
  const visible=createProgressFilter();
  const unsubscribe=engine.subscribe(event=>{const text=describeEvent(event);if(text&&visible(event))say(text);});
  const sayList=(title,items=[])=>{if(!items.length)return;say(title);items.forEach((item,i)=>say(`  ${i+1}. ${item}`));};
  // Ключ вводится скрыто и проверяется тем же бесплатным запросом, что и на странице настроек.
  const connectProvider=async({allowLater=true}={})=>{
    for(;;){
      const provider=await choice(allowLater?'Подключить сервис: 1 Deepgram, 2 AssemblyAI, 3 позже':'Какой сервис подключить: 1 Deepgram, 2 AssemblyAI',allowLater?['deepgram','assemblyai','позже']:['deepgram','assemblyai']);
      if(provider==='позже'){await engine.skipProvider();return;}
      say(checkNotice);
      lines.detach();let result;try{result=await engine.providerKey({provider});}finally{lines.attach();}
      say(keyResultText(result.keyResult));
      if(result.keyResult.saved)return;
    }
  };
  try {
    if(url){say('Панель установки: '+url);try{await openBrowser?.(url);}catch{say('Откройте ссылку вручную; терминал продолжает работать.');}}
    if(connect){await connectProvider({allowLater:false});return engine.snapshot();}
    let s=engine.snapshot();if(s.stages.finish==='done'){say('Настройка уже завершена.');return s;}
    if(s.awaiting==='resume'&&!await yes('Продолжить сохранённую настройку?'))return await engine.cancel();
    if(s.stages.select!=='done'){
      const agent=await choice('Куда установить? 1 Codex, 2 Claude, 3 оба',['codex','claude','оба']);
      const scope=await choice('Область: 1 пользователь, 2 проект',['пользователь','проект']);
      await engine.select({agent:agent==='оба'?'both':agent,scope:scope==='проект'?'project':'user',...(scope==='проект'?{projectRoot:await ask('Абсолютный путь проекта:',path.isAbsolute)}:{})});
    }
    s=engine.snapshot();if(s.stages.inspect!=='done'){if(!await yes('Разрешить проверку версий Node, FFmpeg, ffprobe и yt-dlp?'))return await engine.cancel();await engine.inspect({allowCheck:true});}
    s=engine.snapshot();if(s.stages.install!=='done'){
      await engine.plan();s=engine.snapshot();sayList('План установки:',s.result.planSteps||[]);sayList('Обратите внимание:',s.result.planWarnings||[]);
      if(!await yes('Разрешить установку по этому плану?'))return await engine.cancel();
      await engine.install({allowInstall:true,planId:s.result.planId});s=engine.snapshot();
      if(s.awaiting==='update'){if(!await yes('Скилл уже установлен. Обновить его? Настройки и результаты сохранятся.'))return await engine.cancel();await engine.plan();await engine.install({allowInstall:true,update:true,planId:engine.snapshot().result.planId});}
      s=engine.snapshot();sayList('Обратите внимание:',s.result.install?.warnings||[]);
      if(s.stages.install!=='done'){sayList('Нужно сделать вручную:',(s.result.planSteps||[]).filter((_,i)=>s.result.plan?.[i]?.kind==='manual'));say('Состояние сохранено: после этого запустите установку снова.');return engine.snapshot();}
    }
    s=engine.snapshot();if(!['done','skipped'].includes(s.stages.provider))await connectProvider();
    if(engine.snapshot().stages.configure!=='done'){
      const language=await ask('Язык: auto — определять автоматически, или код, например ru, en:');
      const interval=Number(await ask('Максимальная длина одной реплики субтитров, секунд (например 30; действует, когда сервис вернул тайминги слов):',v=>Number.isFinite(Number(v))&&Number(v)>0));
      const formats=await choice('Форматы: 1 TXT/SRT/VTT, 2 TXT, 3 SRT, 4 VTT',['все','txt','srt','vtt']);
      const diarize=await yes('Разделять участников?');
      const speakerCount=diarize?await ask('Количество участников: auto или положительное целое:',v=>v==='auto'||/^\d+$/.test(v)&&Number(v)>0):'auto';
      const fallback=engine.snapshot().settings?.outputRoot;
      const outputRoot=await ask(fallback?`Папка результата (Enter — ${fallback}, или другой абсолютный путь):`:'Абсолютная папка результата:',v=>(!v&&!!fallback)||path.isAbsolute(v))||fallback;
      await engine.configure({language,interval,formats:formats==='все'?['txt','srt','vtt']:[formats],diarize,speakerCount:speakerCount==='auto'?'auto':Number(speakerCount),outputRoot});
    }
    await engine.finish();say('Готово. Откройте новый чат.');if(await yes('Показать пример первой просьбы?'))say('Транскрибируй мой файл или ссылку. Облачная отправка требует отдельного согласия.');return engine.snapshot();
  }catch(error){if(['CANCELLED','INPUT_CLOSED'].includes(error.code)){say(error.message);return connect?engine.snapshot():await engine.cancel();}throw error;}finally{unsubscribe();lines.close();}
}
