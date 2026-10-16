// Request/normalization algorithms adapted from read-only
// ИИ_монтаж/lib/transcription/{deepgram,assemblyai}.mjs.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { novaLanguages, novaAliases } from './nova-languages.mjs';

export const providerCapabilities = Object.freeze({
  deepgram: Object.freeze({ defaultModel: 'nova-3', models: Object.freeze([...Object.keys(novaLanguages), ...Object.keys(novaAliases)]), languagesByModel: novaLanguages, supportsDiarization: true, supportsSpeakerCount: false }),
  assemblyai: Object.freeze({ defaultModel: 'universal-2', models: Object.freeze(['universal-2', 'universal-3-5-pro']), supportsDiarization: true, supportsSpeakerCount: true }),
});
// Base codes accepted by both Deepgram Nova-3 and AssemblyAI Universal-2 (official tables, 15.10.2026).
export const commonLanguages = Object.freeze(['ru', 'en', 'af', 'ar', 'hy', 'as', 'be', 'bn', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'ka', 'de', 'el', 'gu', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'mr', 'mn', 'ne', 'no', 'ps', 'fa', 'pl', 'pt', 'pa', 'ro', 'sr', 'sk', 'sl', 'es', 'sv', 'tl', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi']);
function fail(provider, code, message) {
  // Provider messages are fixed texts (at most an HTTP status), never response bodies or keys.
  const error = new Error(`${provider}: ${message}`); error.code = code; error.cliSafe = true; return error;
}
// 4xx means the service refused before recognition, so nothing was charged and a
// new attempt is safe. The response body is inspected only for classification.
function httpFailure(provider, status, diagnostic) {
  const [code, message] = /balance is negative|insufficient (?:funds|balance|credit)/i.test(diagnostic) || status === 402 ? ['PROVIDER_NO_FUNDS', 'на счёте закончились средства. Пополните баланс в кабинете сервиса.']
    : status === 401 ? ['PROVIDER_KEY_REJECTED', 'сервис не принял ключ. Проверьте, что ключ скопирован целиком, или замените его.']
      : status === 403 ? ['PROVIDER_FORBIDDEN', 'у ключа недостаточно прав.']
        : status === 429 ? ['PROVIDER_RATE_LIMIT', 'сервис ограничил частоту запросов. Повторите позже.']
          : ['PROVIDER_REJECTED', `сервис отклонил запрос (HTTP ${status}). Проверьте параметры и файл.`];
  return Object.assign(fail(provider, code, message), { httpStatus: status, definitive: true, cliSafe: true });
}
export function canonicalModel(provider, model) { return provider === 'deepgram' && Object.hasOwn(novaAliases, model) ? novaAliases[model] : model; }
export function validateRecognition({ provider, model = providerCapabilities[provider]?.defaultModel, language }) {
  if (!providerCapabilities[provider]) throw new Error('Выберите deepgram или assemblyai.');
  model = canonicalModel(provider, model);
  if (!providerCapabilities[provider].models.includes(model)) throw fail(provider, 'PROVIDER_MODEL', 'выберите поддерживаемую модель.');
  if (language === 'auto') return { provider, model, language };
  if (typeof language !== 'string' || !(language === 'multi' && provider === 'deepgram') && !/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(language)) throw fail(provider, 'PROVIDER_LANGUAGE', 'укажите поддерживаемый код языка.');
  if (provider === 'deepgram' && !novaLanguages[model].includes(language)) throw fail(provider, 'PROVIDER_LANGUAGE', 'выбранная модель не поддерживает этот язык. Выберите сочетание из официальной таблицы Deepgram.');
  if (provider === 'assemblyai') assemblyModel({ model, language });
  return { provider, model, language };
}
function settings(provider, options, resumeOnly = false) {
  const { key, language, diarize = false, speakerCount = 'auto', model: requestedModel = providerCapabilities[provider].defaultModel, providerOptions = {} } = options;
  const model = canonicalModel(provider, requestedModel);
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw fail(provider, 'PROVIDER_KEY', 'настройте API-ключ через скрытый ввод.');
  if (!resumeOnly) validateRecognition({ provider, model, language });
  if (typeof diarize !== 'boolean') throw fail(provider, 'PROVIDER_OPTIONS', 'diarize должен быть boolean.');
  if (speakerCount !== 'auto' && (!Number.isInteger(speakerCount) || speakerCount < 1)) throw fail(provider, 'PROVIDER_OPTIONS', 'число спикеров должно быть auto или положительным целым.');
  const allowed = provider === 'deepgram' ? ['timeoutMs', 'smart_format', 'utt_split'] : ['timeoutMs', 'pollTimeoutMs', 'pollIntervalMs', 'format_text'];
  if (!providerOptions || Array.isArray(providerOptions) || typeof providerOptions !== 'object' || Object.keys(providerOptions).some(name => !allowed.includes(name))) throw fail(provider, 'PROVIDER_OPTIONS', 'неподдерживаемые providerOptions.');
  const extra = { ...providerOptions };
  for (const name of ['timeoutMs', 'pollTimeoutMs', 'pollIntervalMs', 'utt_split']) {
    if (extra[name] !== undefined && (!Number.isFinite(extra[name]) || extra[name] <= 0 || (name !== 'utt_split' && (!Number.isInteger(extra[name]) || extra[name] > 2_147_483_647)))) throw fail(provider, 'PROVIDER_OPTIONS', 'интервалы и timeout должны быть положительными и укладываться в лимит таймера.');
  }
  for (const name of ['smart_format', 'format_text']) if (extra[name] !== undefined && typeof extra[name] !== 'boolean') throw fail(provider, 'PROVIDER_OPTIONS', 'опции форматирования должны быть boolean.');
  return { key, language, diarize, speakerCount, model, extra, timeoutMs: extra.timeoutMs ?? 180_000 };
}
// Deepgram answers 504 after 10 minutes of processing (pre-recorded docs, 15.10.2026), so a
// client timeout must outlast upload + that limit: an earlier cut leaves the request uncertain.
// Upload time is budgeted for a slow ~0.4 Mbit/s link.
const UPLOAD_BYTES_PER_SECOND = 50 * 1024;
const TIMER_LIMIT = 2_147_483_647;
export function requestTimeouts({ bytes = 0, durationSeconds = 0, providerOptions = {} } = {}) {
  const upload = Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000; const cap = value => Math.min(TIMER_LIMIT, Math.ceil(value));
  const explicit = providerOptions.timeoutMs;
  return {
    deepgramMs: explicit ?? cap(11 * 60_000 + upload),
    uploadMs: explicit ?? cap(180_000 + upload),
    requestMs: explicit ?? 180_000,
    pollMs: providerOptions.pollTimeoutMs ?? cap(Math.max(360_000, (Number.isFinite(durationSeconds) ? durationSeconds : 0) * 500)),
  };
}
async function localAudio(provider, filePath, signal) {
  if (signal?.aborted) throw fail(provider, 'PROVIDER_ABORTED', 'операция отменена. Повторная отправка автоматически не выполняется.');
  try { return await readFile(filePath, { signal }); }
  catch { throw fail(provider, signal?.aborted ? 'PROVIDER_ABORTED' : 'INPUT_READ', 'не удалось прочитать аудио.'); }
}
async function requestJson(provider, url, { fetchImpl = fetch, signal, timeoutMs, ...init }) {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(fail(provider, timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ABORTED', timedOut ? 'сервис не ответил вовремя. Исход запроса неизвестен; повторная отправка автоматически не выполняется.' : 'операция отменена. Повторная отправка автоматически не выполняется.'));
    if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      if (controller.signal.aborted) return await cancelled;
      let response;
      try { response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' }); }
      catch { if (controller.signal.aborted) return await cancelled; throw fail(provider, 'PROVIDER_NETWORK', 'сетевая ошибка при обращении к сервису. Исход запроса неизвестен; повторная отправка автоматически не выполняется.'); }
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 'unknown';
        if (status >= 400 && status < 500) {
          let diagnostic = ''; try { diagnostic = (await response.text()).slice(0, 4096); } catch {}
          throw httpFailure(provider, status, diagnostic);
        }
        throw fail(provider, 'PROVIDER_HTTP', `сервис временно не ответил (HTTP ${status}). Исход запроса неизвестен; повторная отправка автоматически не выполняется.`);
      }
      try {
        const raw = await response.json();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
        return raw;
      } catch { throw fail(provider, 'PROVIDER_RESPONSE', 'не удалось прочитать ответ API.'); }
    })()]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
  }
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function languageTag(value) { return typeof value === 'string' && /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/i.test(value) ? value : undefined; }
async function saveResponse(provider, raw, onResponse) {
  if (onResponse === undefined) return;
  try { await onResponse(raw); }
  catch { throw fail(provider, 'PROVIDER_STATE_SAVE', 'не удалось сохранить ответ сервиса. Повторная отправка запрещена.'); }
}
function timed(provider, item, divisor, wordText, speaker) {
  if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) throw fail(provider, 'PROVIDER_RESPONSE', 'ответ содержит некорректные тайминги.');
  return { start: item.start / divisor, end: item.end / divisor, text: wordText, ...(speaker === undefined ? {} : { speaker }) };
}
function turnsFromWords(words) {
  const turns = [];
  for (const word of words) {
    const previous = turns.at(-1);
    if (previous && previous.speaker === word.speaker && word.start - previous.end <= 0.5) { previous.end = Math.max(previous.end, word.end); previous.text += ` ${word.text}`; }
    else turns.push({ ...word });
  }
  return turns;
}
export function normalizeDeepgram(raw, { diarize = false, speakerCount = 'auto' } = {}) {
  const alternative = raw?.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative || typeof alternative !== 'object' || Array.isArray(alternative)) throw fail('deepgram', 'PROVIDER_RESPONSE', 'ответ не содержит результат распознавания.');
  const records = value => {
    const items = value ?? [];
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw fail('deepgram', 'PROVIDER_RESPONSE', 'некорректные слова или реплики API.');
    return items;
  };
  const sourceWords = records(alternative.words);
  const utterances = records(raw.results.utterances);
  for (const turn of utterances) records(turn.words);
  const speaker = value => diarize && Number.isInteger(value) && value >= 0 ? value + 1 : undefined;
  const words = sourceWords.filter(word => text(word.punctuated_word ?? word.word)).map(word => timed('deepgram', word, 1, text(word.punctuated_word ?? word.word), speaker(word.speaker)));
  let speakerTurns = utterances.filter(turn => text(turn.transcript) || turn.words?.length).map(turn => timed('deepgram', { start: turn.start ?? turn.words?.[0]?.start, end: turn.end ?? turn.words?.at(-1)?.end }, 1, text(turn.transcript) || turn.words.map(word => text(word.punctuated_word ?? word.word)).filter(Boolean).join(' '), speaker(turn.speaker ?? turn.words?.[0]?.speaker)));
  if (!speakerTurns.length && diarize) speakerTurns = turnsFromWords(words);
  const modelInfo = Object.values(raw.metadata?.model_info ?? {})[0];
  const model = text(modelInfo?.arch) || text(modelInfo?.name);
  const warnings = [];
  if (diarize && speakerCount !== 'auto') warnings.push('Deepgram не поддерживает подсказку числа спикеров; количество определяется по аудио.');
  if (diarize && ![...words, ...speakerTurns].some(item => item.speaker)) warnings.push('API не вернул метки спикеров.');
  if (!model) warnings.push('API не сообщил фактическую модель; запрошенная модель хранится в параметрах запуска.');
  const detectedLanguage = languageTag(raw.results.channels[0].detected_language);
  return { text: text(alternative.transcript) || (words.length ? words : speakerTurns).map(item => item.text).join(' '), words, speakerTurns, ...(Number.isFinite(raw.metadata?.duration) ? { durationSeconds: raw.metadata.duration } : {}), ...(model ? { model } : {}), ...(detectedLanguage ? { detectedLanguage } : {}), raw, warnings };
}
export async function transcribeDeepgram(options) {
  const config = settings('deepgram', options);
  const url = new URL('https://api.deepgram.com/v1/listen');
  for (const [name, value] of Object.entries({ ...(config.language === 'auto' ? { detect_language: true } : { language: config.language }), model: config.model, punctuate: true, diarize: config.diarize, utterances: config.diarize, smart_format: config.extra.smart_format ?? true, ...(config.extra.utt_split === undefined ? {} : { utt_split: config.extra.utt_split }) })) url.searchParams.set(name, String(value));
  const body = await localAudio('deepgram', options.filePath, options.signal);
  const { deepgramMs } = requestTimeouts({ bytes: body.length, providerOptions: config.extra });
  const raw = await requestJson('deepgram', url.href, { method: 'POST', headers: { Authorization: `Token ${config.key}`, 'content-type': 'audio/flac' }, body, fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: deepgramMs });
  await saveResponse('deepgram', raw, options.onResponse);
  return normalizeDeepgram(raw, config);
}
const ASSEMBLY_BASE = 'https://api.assemblyai.com';
const PRO_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'da', 'nl', 'he', 'hi', 'ja', 'zh', 'vi', 'fi', 'no', 'sv', 'tr']);
function assemblyLanguage(language) { return language.toLowerCase().replace('-', '_'); }
function assemblyModel(config) {
  if (config.language === 'auto') return;
  if (config.model === 'universal-3-5-pro' && !PRO_LANGUAGES.has(config.language.split(/[-_]/)[0])) throw fail('assemblyai', 'PROVIDER_LANGUAGE', 'выбранная модель не поддерживает этот язык. Выберите universal-2 явно.');
}
function jobId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail('assemblyai', 'PROVIDER_RESPONSE', 'некорректный ID задачи.');
  return id;
}
export function normalizeAssemblyAi(raw, { diarize = false } = {}) {
  if (!raw || raw.status !== 'completed') throw fail('assemblyai', 'PROVIDER_RESPONSE', 'задача распознавания не завершена.');
  const records = value => {
    const items = value ?? [];
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw fail('assemblyai', 'PROVIDER_RESPONSE', 'некорректные слова или реплики API.');
    return items;
  };
  const utterances = records(raw.utterances);
  const topWords = records(raw.words);
  for (const turn of utterances) records(turn.words);
  const labels = new Map();
  const speaker = value => {
    if (!diarize || value === undefined || value === null || value === '') return undefined;
    if (!labels.has(value)) labels.set(value, labels.size + 1);
    return labels.get(value);
  };
  const nested = utterances.flatMap(turn => (turn.words ?? []).map(word => ({ ...word, speaker: word.speaker ?? turn.speaker })));
  const inherited = new Map(nested.map(word => [`${word.start}:${word.end}:${word.text}`, word.speaker]));
  const sourceWords = topWords.length ? topWords : nested;
  const words = sourceWords.filter(word => text(word.text)).map(word => timed('assemblyai', word, 1000, text(word.text), speaker(word.speaker ?? inherited.get(`${word.start}:${word.end}:${word.text}`))));
  let speakerTurns = diarize || !words.length ? utterances.filter(turn => text(turn.text)).map(turn => timed('assemblyai', turn, 1000, text(turn.text), speaker(turn.speaker))) : [];
  if (!speakerTurns.length && diarize) speakerTurns = turnsFromWords(words);
  const model = text(raw.speech_model_used); const warnings = [];
  if (diarize && ![...words, ...speakerTurns].some(item => item.speaker)) warnings.push('API не вернул метки спикеров.');
  if (!model) warnings.push('API не сообщил фактическую модель; запрошенная модель хранится в параметрах запуска.');
  const detectedLanguage = raw.language_detection === true ? languageTag(raw.language_code) : undefined;
  return { text: text(raw.text) || (words.length ? words : speakerTurns).map(item => item.text).join(' '), words, speakerTurns, ...(Number.isFinite(raw.audio_duration) ? { durationSeconds: raw.audio_duration } : {}), ...(model ? { model } : {}), ...(detectedLanguage ? { detectedLanguage } : {}), raw, warnings };
}
async function pollAssembly({ id, config, fetchImpl, signal, onResponse, durationSeconds }) {
  const overall = AbortSignal.timeout(requestTimeouts({ durationSeconds, providerOptions: config.extra }).pollMs);
  const combined = signal ? AbortSignal.any([signal, overall]) : overall;
  try {
    for (;;) {
      const raw = await requestJson('assemblyai', `${ASSEMBLY_BASE}/v2/transcript/${encodeURIComponent(id)}`, { method: 'GET', headers: { Authorization: config.key }, fetchImpl, signal: combined, timeoutMs: config.timeoutMs });
      if (raw.status === 'completed') {
        await saveResponse('assemblyai', raw, onResponse);
        return normalizeAssemblyAi(raw, config);
      }
      if (raw.status === 'error') throw fail('assemblyai', 'PROVIDER_JOB_FAILED', 'сервис сообщил об ошибке распознавания. Повторная отправка автоматически не выполняется.');
      if (!['queued', 'processing'].includes(raw.status)) throw fail('assemblyai', 'PROVIDER_RESPONSE', 'неизвестный статус задачи.');
      await sleep(config.extra.pollIntervalMs ?? 3_000, undefined, { signal: combined });
    }
  } catch (error) {
    if (overall.aborted && !signal?.aborted) error = fail('assemblyai', 'PROVIDER_TIMEOUT', 'истекло ожидание задачи. Используйте resume по сохранённому ID.');
    else if (signal?.aborted) error = fail('assemblyai', 'PROVIDER_ABORTED', 'операция отменена. Используйте resume по сохранённому ID.');
    error.providerJob = { id, provider: 'assemblyai' };
    throw error;
  }
}
export async function transcribeAssemblyAi(options) {
  const config = settings('assemblyai', options); assemblyModel(config);
  if (typeof options.onSubmitted !== 'function') throw fail('assemblyai', 'PROVIDER_OPTIONS', 'необходим onSubmitted для сохранения ID до polling.');
  const headers = { Authorization: config.key };
  const audio = await localAudio('assemblyai', options.filePath, options.signal);
  const upload = await requestJson('assemblyai', `${ASSEMBLY_BASE}/v2/upload`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: audio, fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: requestTimeouts({ bytes: audio.length, providerOptions: config.extra }).uploadMs });
  try { if (new URL(upload.upload_url).protocol !== 'https:') throw new Error(); }
  catch { throw fail('assemblyai', 'PROVIDER_RESPONSE', 'API не вернул корректный адрес загруженного аудио.'); }
  // fallback_language must be listed in expected_languages; the list is a hint, not a filter.
  const language = config.language === 'auto' ? { language_detection: true, language_detection_options: { expected_languages: ['ru', 'en'], fallback_language: 'ru' } } : { language_code: assemblyLanguage(config.language) };
  const body = { audio_url: upload.upload_url, ...language, speaker_labels: config.diarize, speech_models: [config.model], punctuate: true, format_text: config.extra.format_text ?? true, ...(config.diarize && config.speakerCount !== 'auto' ? { speakers_expected: config.speakerCount } : {}) };
  const submitted = await requestJson('assemblyai', `${ASSEMBLY_BASE}/v2/transcript`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: config.timeoutMs });
  const id = jobId(submitted.id);
  // Never poll until the caller has durably saved the ID. Callback failure
  // keeps the paid request uncertain; it cannot justify a fresh submission.
  try { await options.onSubmitted({ id, provider: 'assemblyai' }); }
  catch { const error = fail('assemblyai', 'PROVIDER_STATE_SAVE', 'не удалось сохранить номер задания. Повторная отправка запрещена.'); error.providerJob = { id, provider: 'assemblyai' }; throw error; }
  return pollAssembly({ id, config, fetchImpl: options.fetchImpl, signal: options.signal, onResponse: options.onResponse, durationSeconds: options.durationSeconds });
}
export async function resumeAssemblyAi(options) {
  const config = settings('assemblyai', options, true);
  return pollAssembly({ id: jobId(options.id), config, fetchImpl: options.fetchImpl, signal: options.signal, onResponse: options.onResponse, durationSeconds: options.durationSeconds });
}
export async function transcribe(options) {
  if (options.provider === 'deepgram') return transcribeDeepgram(options);
  if (options.provider === 'assemblyai') return transcribeAssemblyAi(options);
  throw new Error('Выберите deepgram или assemblyai.');
}
export async function resume(options) {
  if (options.provider === 'assemblyai') return resumeAssemblyAi(options);
  throw new Error('Resume доступен только AssemblyAI.');
}
