// Общие тексты и ссылки сервисов: модуль без зависимостей, его загружает и Node, и страница /setup.
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
export const providerGuides = freeze({
 deepgram: {title:'Deepgram',signupUrl:'https://console.deepgram.com/signup?jump=keys',keyUrl:'https://console.deepgram.com/',keyHint:'Projects → Settings → API Keys → Create a New API Key',consoleUrl:'https://console.deepgram.com/',pricingUrl:'https://deepgram.com/pricing',docsUrl:'https://developers.deepgram.com/docs/create-additional-api-keys',checkedAt:'2026-10-15',
  registration:['Откройте страницу регистрации Deepgram.','Зарегистрируйтесь или войдите самостоятельно.'],
  obtainKey:['В кабинете выберите проект, откройте Settings → API Keys.','Нажмите Create a New API Key, задайте имя и скопируйте ключ целиком. Административные права для распознавания не нужны.'],
  help:'Если кабинет выглядит иначе, ищите раздел API Keys в настройках проекта или откройте «Справку API». Если создать ключ нельзя из-за прав, попросите владельца проекта выдать ключ с доступом к распознаванию.',
  diarization:'Разделение участников входит в цену распознавания; число участников Deepgram определяет сам.'},
 assemblyai: {title:'AssemblyAI',signupUrl:'https://www.assemblyai.com/dashboard/signup',keyUrl:'https://www.assemblyai.com/dashboard/api-keys',keyHint:'Workspace → Manage → API Keys → Create New API Key',consoleUrl:'https://www.assemblyai.com/dashboard/',pricingUrl:'https://www.assemblyai.com/pricing',docsUrl:'https://www.assemblyai.com/docs/account-management',checkedAt:'2026-10-15',
  registration:['Откройте страницу регистрации AssemblyAI.','Зарегистрируйтесь или войдите самостоятельно.'],
  obtainKey:['В кабинете откройте Workspace → Manage → API Keys.','Нажмите Create New API Key, задайте имя, нажмите Create и скопируйте ключ целиком.'],
  help:'Если кабинет выглядит иначе, ищите раздел API Keys в меню рабочего пространства или откройте «Справку API». Если создать ключ нельзя из-за прав, попросите владельца рабочего пространства выдать ключ.',
  diarization:'Разделение участников — доплата $0,02 за час к базовым $0,15 за час (Universal-2, цены на 15.10.2026). Число участников можно указать.'}
});
export const allowedLinkHosts = Object.freeze(['console.deepgram.com','developers.deepgram.com','deepgram.com','www.assemblyai.com']);
export const checkNotice = 'Ключ будет проверен бесплатным запросом к сервису. Аудио не отправляется.';
const unreachable = 'Не удалось связаться с сервисом. Ключ сохранён; нажмите «Проверить снова».';
// Итог «Сохранить и проверить» одной строкой: страница и терминал показывают одно и то же.
export function keyResultText({saved,status}={}) {
 if(status==='rejected')return 'Сервис не принял ключ. Проверьте, что скопировали его целиком.';
 if(status==='insufficient-permissions')return 'У ключа недостаточно прав.';
 if(status==='cancelled')return 'Проверка отменена. Ключ не сохранён.';
 if(saved&&status==='confirmed')return 'Ключ проверен и сохранён.';
 return saved?unreachable:'Ключ не сохранён.';
}
export function verificationText(verification) {
 const status=verification?.status;
 if(status==='confirmed'){const date=new Date(verification.checkedAt);return Number.isNaN(date.getTime())?'Ключ проверен.':`Ключ проверен ${date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})}.`;}
 if(status==='rejected')return 'Сервис не принял сохранённый ключ. Замените его.';
 if(status==='insufficient-permissions')return 'У сохранённого ключа недостаточно прав.';
 if(['rate-limited','unavailable','network-error','inconclusive'].includes(status))return unreachable;
 return 'Ключ сохранён, но не проверен.';
}
