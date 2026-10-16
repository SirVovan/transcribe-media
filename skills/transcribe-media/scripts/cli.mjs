#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, rmdir } from 'node:fs/promises';
import * as configuration from '../lib/config/index.mjs';
import * as jobs from '../lib/jobs/index.mjs';
import * as transcript from '../lib/transcript/index.mjs';
import * as sources from '../lib/sources/index.mjs';
import * as providers from '../lib/providers/index.mjs';
import * as installation from '../lib/install/index.mjs';
import { fileSystemError } from '../lib/errors.mjs';

const values = new Set(['config', 'project-config', 'language', 'interval', 'formats', 'provider', 'speakers', 'model', 'output', 'work', 'ffmpeg', 'ffprobe', 'yt-dlp', 'node', 'strategy', 'cookies', 'cookies-browser', 'source-proxy', 'agent', 'scope', 'project-root']);
const booleans = new Set(['diarize', 'no-diarize', 'allow-cookies', 'allow-cloud', 'keep-temp', 'plan', 'allow-install', 'update', 'dry-run', 'repair', 'help', 'confirm-uncertain']);
const help = `transcribe-media — локальные файлы и ссылки на видео\nКоманды: help; setup; provider add/remove/enable/disable/default/status; install; doctor; transcribe INPUT; reformat PATH; resume RUN_ID; cleanup [RUN_ID] [--dry-run]; unlock RUN_ID [--confirm-uncertain]; list.\ncleanup без RUN_ID убирает прошлые запуски: временные файлы, служебные папки завершённых запусков, кэш старше 14 дней, пустые папки результатов; --dry-run только показывает список.\nunlock снимает запрет повторной отправки после оборванного запроса; --confirm-uncertain — только с согласия пользователя: сервис мог обработать и оплатить прежний запрос.
list показывает последние запуски: runId, название, статус, папку результата и нужное действие (resume или unlock).\nОбщие флаги: --config PATH --project-config PATH --language auto|CODE --interval SECONDS --formats txt,srt,vtt --provider deepgram|assemblyai --diarize|--no-diarize --speakers auto|N --model MODEL --output PATH --work PATH --ffmpeg PATH --ffprobe PATH --yt-dlp PATH --node PATH --strategy auto|word-timestamps --cookies PATH --cookies-browser BROWSER --allow-cookies --source-proxy system|direct --allow-cloud --keep-temp --plan.\n--interval SECONDS — максимальная длина одной реплики субтитров (по умолчанию 30); действует, когда сервис вернул тайминги слов, у субтитров источника границы фраз сохраняются.\n--source-proxy direct — ссылки (yt-dlp) читаются напрямую, мимо прокси из переменных окружения и системы; system (по умолчанию) — как настроено в системе; setup --source-proxy сохраняет выбор.\nНастройка ключа: provider add NAME (скрытый ввод в терминале) или страница настроек; ключ через argv запрещён.\nУстановка: --agent codex|claude|both --scope user|project --project-root PATH --allow-install --update --dry-run. Doctor: [--repair --allow-install].\n`;
function fail(code, message, extras = {}) { return Object.assign(new Error(message), { code, cliSafe: true, ...extras }); }
const installerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'installer.mjs');
const settingsCommandFor = configPath => `"${process.execPath}" "${installerPath}" settings --config "${configPath}"`;
function settingsRequired(code, message, configPath) { const settingsCommand = settingsCommandFor(configPath); return fail(code, `${message} Откройте страницу настроек: ${settingsCommand}`, { installerPath, settingsCommand }); }
function languageName(code) {
  let name; try { name = new Intl.DisplayNames(['ru'], { type: 'language' }).of(code); } catch {}
  return name && name !== code ? `${name} (${code})` : code;
}
function languageNote(code) { return `Определён язык: ${languageName(code)}`; }
// Lines of the confirmation form the assistant shows before transcription.
function planSummary(config) {
  const language = config.language === 'auto' ? 'автоопределение' : config.language === 'multi' ? 'несколько языков (multi)' : languageName(config.language);
  const speakers = config.diarize ? `включено${Number.isInteger(config.speakerCount) ? `, спикеров: ${config.speakerCount}` : ''}` : 'выключено';
  return [`Язык: ${language}`, `Длина субтитра: ${config.interval} с`, `Разделение по спикерам: ${speakers}`, `Сервис: ${config.provider === 'assemblyai' ? 'AssemblyAI' : 'Deepgram'} (${config.model})`];
}
// Title and aligned block for the form's preview pane (approved by the user 15.10).
function planForm(config, requestedSource) {
  const name = requestedSource.type === 'local' ? path.basename(requestedSource.input) : requestedSource.input;
  const language = config.language === 'auto' ? 'автоопределение' : config.language === 'multi' ? 'несколько языков (multi)' : languageName(config.language);
  const speakers = config.diarize ? `разделять${Number.isInteger(config.speakerCount) ? ` (${config.speakerCount})` : ''}` : 'не разделять';
  const row = (label, value) => `${label.padEnd(11)}${value}`;
  return { formTitle: `Расшифровать «${name}»?`, formPreview: [row('Файл', name), '', row('Язык', language), row('Субтитры', `до ${config.interval} с на строку`), row('Спикеры', speakers), row('Сервис', `${config.provider === 'assemblyai' ? 'AssemblyAI' : 'Deepgram'} (${config.model})`)].join('\n') };
}
function safeProviderJob(value) { return value?.provider === 'assemblyai' && typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value.id) ? { provider: 'assemblyai', id: value.id } : undefined; }
function previewSource(input, cwd) {
  if (!/^https?:\/\//i.test(input)) return { type: 'local', input: path.resolve(cwd, input) };
  let url; try { url = new URL(input); } catch { throw fail('CLI_SOURCE', 'Некорректный URL источника.'); }
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return { type: 'url', input: url.toString() };
}
function parse(args) {
  const flags = {}, positionals = []; let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (literal) { positionals.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const [name, ...suffix] = arg.slice(2).split('=');
    if (!values.has(name) && !booleans.has(name)) throw fail('CLI_ARGUMENT', 'Неизвестный флаг. Используйте help; ключи через argv запрещены.');
    if (Object.hasOwn(flags, name)) throw fail('CLI_ARGUMENT', 'Флаг задан повторно.');
    if (booleans.has(name)) { if (suffix.length) throw fail('CLI_ARGUMENT', 'Логический флаг не принимает значение.'); flags[name] = true; }
    else { const value = suffix.length ? suffix.join('=') : args[++i]; if (!value || value.startsWith('--')) throw fail('CLI_ARGUMENT', 'Укажите значение флага.'); flags[name] = value; }
  }
  if (flags.diarize && flags['no-diarize']) throw fail('CLI_ARGUMENT', 'Выберите один режим спикеров.');
  if (flags.strategy && !['auto', 'word-timestamps'].includes(flags.strategy)) throw fail('CLI_ARGUMENT', 'strategy: auto или word-timestamps.');
  return { flags, positionals };
}
function overrides(flags, cwd) {
  const patch = {};
  for (const name of ['language', 'provider', 'model']) if (flags[name] !== undefined) patch[name] = flags[name];
  if (flags.interval !== undefined) patch.interval = Number(flags.interval);
  if (flags.formats !== undefined) patch.formats = flags.formats.split(',');
  if (flags.diarize || flags['no-diarize']) patch.diarize = !!flags.diarize;
  if (flags['source-proxy'] !== undefined) patch.sourceProxy = flags['source-proxy'];
  if (flags.speakers !== undefined) patch.speakerCount = flags.speakers === 'auto' ? 'auto' : Number(flags.speakers);
  for (const [flag, name] of [['output', 'outputRoot'], ['work', 'workRoot']]) if (flags[flag]) patch[name] = path.resolve(cwd, flags[flag]);
  for (const [flag, name] of [['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe'], ['yt-dlp', 'ytdlp'], ['node', 'node']]) if (flags[flag]) (patch.tools ||= {})[name] = /[\\/]/.test(flags[flag]) ? path.resolve(cwd, flags[flag]) : flags[flag];
  // Cookie permission is per invocation, never inherited from saved settings.
  patch.sourceAccess = { allowCookies: !!flags['allow-cookies'], ...(flags.cookies ? { cookiesFile: path.resolve(cwd, flags.cookies) } : {}), ...(flags['cookies-browser'] ? { cookiesBrowser: flags['cookies-browser'] } : {}) };
  return patch;
}
function publicParameters(config, flags) {
  return { language: config.language, interval: config.interval, formats: config.formats, provider: config.provider, model: config.model, diarize: config.diarize, speakerCount: config.speakerCount, providerOptions: config.providerOptions || {}, strategy: flags.strategy || 'auto', outputRoot: config.outputRoot, workRoot: config.workRoot, allowCloud: !!flags['allow-cloud'], keepTemp: !!flags['keep-temp'] };
}
export async function main(args = process.argv.slice(2), options = {}) {
  const injected = options.dependencies || options;
  const d = { ...configuration, ...jobs, ...transcript, ...sources, ...installation, providerCapabilities: providers.providerCapabilities, canonicalModel: providers.canonicalModel, validateRecognition: providers.validateRecognition, transcribe: providers.transcribe, resume: providers.resume, ...injected };
  const cwd = path.resolve(typeof d.cwd === 'function' ? d.cwd() : d.cwd || process.cwd());
  const emit = value => (d.stdout || (text => process.stdout.write(text)))(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  const errorOutput = value => (d.stderr || (text => process.stderr.write(text)))(JSON.stringify(value, null, 2) + '\n');
  let job;
  try {
    const { flags, positionals } = parse(args);
    const [command = 'help', ...inputs] = positionals;
    if (command === 'help' || flags.help) { emit(help); return { exitCode: 0, status: 'help' }; }
    const configPath = path.resolve(cwd, flags.config || d.defaultPaths().configPath);
    const projectConfigPath = flags['project-config'] ? path.resolve(cwd, flags['project-config']) : undefined;
    const patch = overrides(flags, cwd);
    const settingsPath = projectConfigPath || configPath;
    const readSettings = async () => {
      const result = { ...d.defaultPaths(), tools: {} };
      for (const file of [configPath, projectConfigPath].filter(Boolean)) {
        let saved; try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw fail('CONFIG_READ', 'Не удалось прочитать JSON настроек.'); }
        for (const name of ['credentialsFile', 'workRoot', 'outputRoot', 'language', 'interval']) if (saved[name] !== undefined) result[name] = saved[name];
        result.tools = { ...result.tools, ...(saved.tools || {}) };
      }
      for (const name of ['credentialsFile', 'workRoot', 'outputRoot']) result[name] = path.resolve(cwd, patch[name] ?? result[name]);
      result.tools = { ...result.tools, ...patch.tools };
      for (const [name, value] of Object.entries(result.tools)) if (typeof value !== 'string' || !value) throw fail('CONFIG_TOOLS', 'Некорректный путь инструмента.'); else if (/[\\/]/.test(value)) result.tools[name] = path.resolve(cwd, value);
      return result;
    };
    const resolve = async (extra = {}) => {
      const config = await d.resolveConfig({ configPath, projectConfigPath, overrides: { ...patch, ...extra }, cwd });
      config.sourceAccess = { ...config.sourceAccess, allowCookies: !!flags['allow-cookies'] };
      if (config.sourceAccess.cookiesFile) config.sourceAccess.cookiesFile = path.resolve(cwd, config.sourceAccess.cookiesFile);
      if (!d.providerCapabilities[config.provider]) throw fail('CLI_PROVIDER', 'Выберите deepgram или assemblyai.');
      config.model = config.model ?? config.providers?.[config.provider]?.model ?? d.providerCapabilities[config.provider].defaultModel;
      return config;
    };
    if (command === 'setup') {
      if (inputs.length) throw fail('CLI_ARGUMENT', 'setup принимает параметры только через флаги.');
      let config; try { config = await resolve(); d.validateRecognition({ provider: config.provider, model: d.canonicalModel(config.provider, config.model), language: config.language }); } catch { throw fail('SETUP_INVALID', 'Проверьте language, положительный interval, formats, параметры спикеров и source-proxy.'); }
      const setupPatch = { ...patch }; delete setupPatch.sourceAccess;
      emit({ status: flags.plan ? 'planned' : 'preview', parameters: publicParameters(config, flags) });
      if (!flags.plan) await d.saveConfig({ configPath: settingsPath, patch: setupPatch, project: !!projectConfigPath });
      const result = { exitCode: 0, status: flags.plan ? 'planned' : 'configured', configPath: settingsPath }; emit(result); return result;
    }
    if (command === 'provider') {
      const [action, provider] = inputs;
      if (!['add', 'remove', 'enable', 'disable', 'default', 'status'].includes(action) || (action === 'status' ? inputs.length !== 1 : inputs.length !== 2 || !['deepgram', 'assemblyai'].includes(provider))) throw fail('CLI_ARGUMENT', 'provider: add/remove/enable/disable/default NAME либо status.');
      const settings = await readSettings();
      if (flags.plan) { const result = { exitCode: 0, status: 'planned', action, ...(provider ? { provider } : {}) }; emit(result); return result; }
      let result;
      if (action === 'status') result = { exitCode: 0, status: 'status', providers: await d.providerStatus({ configPath, projectConfigPath, credentialsFile: settings.credentialsFile }) };
      else if (action === 'add') {
        const configured = await d.configureKey(provider, { configPath: settingsPath, credentialsFile: settings.credentialsFile });
        await d.updateProvider(provider, { configPath: settingsPath, enabled: true, ...(flags.model ? { model: flags.model } : {}) });
        result = { exitCode: 0, status: configured.saved ? 'saved' : 'unverified', provider, verification: 'unverified' };
      } else if (action === 'remove') { await d.removeProviderKey(provider, { credentialsFile: settings.credentialsFile }); result = { exitCode: 0, status: 'removed', provider }; }
      else { await d.updateProvider(provider, { configPath: settingsPath, ...(action === 'default' ? { makeDefault: true } : { enabled: action === 'enable' }), ...(flags.model ? { model: flags.model } : {}) }); result = { exitCode: 0, status: action === 'default' ? 'default' : action === 'enable' ? 'enabled' : 'disabled', provider }; }
      emit(result); return result;
    }
    if (command === 'install' || command === 'doctor') {
      if (inputs.length) throw fail('CLI_ARGUMENT', 'install/doctor принимают параметры через флаги.');
      const settings = await readSettings();
      const common = { tools: settings.tools, allowInstall: !!flags['allow-install'], dryRun: !!(flags.plan || flags['dry-run']), ...(d.runProcess ? { runProcess: d.runProcess } : {}), ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) };
      let result;
      if (command === 'install') {
        if (!['codex', 'claude', 'both'].includes(flags.agent) || !['user', 'project'].includes(flags.scope)) throw fail('INSTALL_ARGUMENT', 'Укажите --agent codex|claude|both и --scope user|project.');
        result = await d.installPackage({ ...common, agent: flags.agent, scope: flags.scope, projectRoot: flags['project-root'] ? path.resolve(cwd, flags['project-root']) : flags.scope === 'project' ? cwd : undefined, update: !!flags.update });
      } else if (flags.repair) result = await d.repairDependencies(common);
      else { const inspection = await d.inspectDependencies(common); result = { status: inspection.ready ? 'ready' : 'manual-required', inspection, warnings: inspection.warnings || [] }; }
      if (result.tools && !common.dryRun && ['installed', 'updated', 'repaired', 'ready'].includes(result.status)) await d.saveConfig({ configPath: settingsPath, patch: { tools: result.tools }, project: !!projectConfigPath });
      const settingsCommand = settingsCommandFor(settingsPath);
      const answer = { exitCode: result.status === 'manual-required' ? 2 : 0, ...result, ...(command === 'install' && ['installed', 'updated', 'existing', 'ready'].includes(result.status) ? { installerPath, settingsCommand, nextStep: `Чтобы подключить сервис распознавания, откройте страницу настроек: ${settingsCommand}` } : {}) }; emit(answer); return answer;
    }
    if (command === 'cleanup') {
      if (inputs.length > 1) throw fail('CLI_ARGUMENT', 'cleanup принимает не больше одного RUN_ID.');
      const settings = await readSettings();
      if (!inputs.length) {
        const dryRun = !!(flags['dry-run'] || flags.plan);
        const swept = await d.cleanupWork({ workRoot: settings.workRoot, outputRoot: settings.outputRoot, dryRun, now: typeof d.now === 'function' ? d.now() : Date.now() });
        const result = { exitCode: 0, status: dryRun ? 'planned' : 'cleaned', ...swept }; emit(result); return result;
      }
      // A cleanup failure must not overwrite a completed job with failed status.
      const activeJob = await d.findJob({ workRoot: settings.workRoot, runId: inputs[0] });
      const cleaned = await d.cleanupJob(activeJob, { dryRun: !!(flags['dry-run'] || flags.plan), keepTemp: !!flags['keep-temp'] });
      const result = { exitCode: 0, status: flags['dry-run'] || flags.plan ? 'planned' : 'cleaned', runId: activeJob.runId, ...cleaned }; emit(result); return result;
    }
    if (command === 'list') {
      if (inputs.length) throw fail('CLI_ARGUMENT', 'list не принимает аргументов.');
      const settings = await readSettings();
      const result = { exitCode: 0, status: 'list', ...(await d.listJobs({ workRoot: settings.workRoot })) }; emit(result); return result;
    }
    if (command === 'unlock') {
      if (inputs.length !== 1) throw fail('CLI_ARGUMENT', 'unlock требует один RUN_ID.');
      const settings = await readSettings();
      const activeJob = await d.findJob({ workRoot: settings.workRoot, runId: inputs[0] });
      if (flags.plan) { const result = { exitCode: 0, status: 'planned', runId: activeJob.runId, confirmUncertain: !!flags['confirm-uncertain'] }; emit(result); return result; }
      const outcome = activeJob.cacheKey ? await d.unlockRequest({ workRoot: settings.workRoot, cacheKey: activeJob.cacheKey, confirmUncertain: !!flags['confirm-uncertain'] }) : { status: 'not-blocked' };
      const message = { 'not-blocked': 'Повторная отправка этого файла не заблокирована.', 'confirmation-required': `Исход прежней отправки неизвестен: сервис мог обработать и оплатить запрос, и новая отправка будет оплачена повторно (двойная оплата). Проверьте историю запросов в кабинете сервиса и спросите пользователя. Снять блокировку: unlock ${activeJob.runId} --confirm-uncertain.`, unlocked: 'Блокировка снята. Следующий transcribe с --allow-cloud отправит файл заново и будет оплачен.' }[outcome.status];
      const result = { exitCode: outcome.status === 'confirmation-required' ? 2 : 0, ...outcome, runId: activeJob.runId, message }; emit(result); return result;
    }
    const sourceOptions = (config, activeJob) => ({ config, cwd, tempDir: activeJob?.tempDir, registerTemp: activeJob ? file => d.registerTemp(activeJob, file) : undefined, ...(d.runProcess ? { runProcess: d.runProcess } : {}), ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), ...(d.signal ? { signal: d.signal } : {}) });
    const complete = async (activeJob, config, normalized, raw, method, onPersist) => {
      const safeSource = d.publicSource(activeJob.source);
      const safeTranscript = { ...normalized, source: safeSource, method };
      // Recovery must survive both formatting and output errors.
      if (activeJob.cacheKey && method === 'api') await d.writeCache({ workRoot: config.workRoot, cacheKey: activeJob.cacheKey, transcript: safeTranscript, raw });
      await d.saveResult(activeJob, { transcript: safeTranscript, raw, source: safeSource, files: {} });
      if (onPersist) await onPersist();
      const formatted = d.formatTranscript(safeTranscript, { interval: config.interval, formats: config.formats, diarize: config.diarize });
      await d.saveResult(activeJob, { ...formatted, raw, source: safeSource });
      let warnings = [...new Set([...(activeJob.warnings || []), ...(formatted.warnings || [])])];
      try { const cleaned = await d.cleanupJob(activeJob, { keepTemp: !!flags['keep-temp'] }); warnings = [...new Set([...warnings, ...(cleaned.warnings || [])])]; }
      catch { warnings.push('Временные файлы не удалены; результат сохранён.'); }
      const detectedLanguage = formatted.transcript.detectedLanguage;
      const result = { exitCode: 0, status: 'complete', runId: activeJob.runId, outputDir: activeJob.outputDir, method, timingPrecision: formatted.transcript.timingPrecision, ...(detectedLanguage ? { detectedLanguage, languageNote: languageNote(detectedLanguage) } : {}), warnings };
      emit(result); return result;
    };
    if (command === 'transcribe') {
      if (inputs.length !== 1) throw fail('CLI_ARGUMENT', 'transcribe требует один INPUT.');
      const config = await resolve(); config.model = d.canonicalModel(config.provider, config.model); const plan = publicParameters(config, flags);
      const requestedSource = previewSource(inputs[0], cwd);
      const form = flags.plan ? { summary: planSummary(config), ...planForm(config, requestedSource), settingsCommand: settingsCommandFor(settingsPath) } : {};
      emit({ status: flags.plan ? 'planned' : 'preview', source: requestedSource, parameters: plan, ...form });
      if (flags.plan) return { exitCode: 0, status: 'planned', source: requestedSource, plan, ...form };
      const source = await d.inspectSource(inputs[0], sourceOptions(config));
      job = await d.createJob({ workRoot: config.workRoot, outputRoot: config.outputRoot, title: source.title, source: d.publicSource(source), parameters: plan });
      let prepared;
      if (source.type === 'direct') {
        prepared = await d.prepareAudio(source, sourceOptions(config, job));
        // The provisional URL identity must never reach cache/payment lookup.
        if (!source.downloadFingerprint || source.identity !== `sha256:${source.downloadFingerprint.sha256}`) throw fail('SOURCE_CHANGED', 'Содержимое прямого источника не проверено.');
        await d.verifySource(source);
        job.source = d.publicSource(source); job.warnings.push(...(prepared.warnings || []));
      }
      job.cacheKey = d.cacheKeyFor({ source, config }); await d.saveJob(job);
      const previous = await d.findResult({ outputRoot: config.outputRoot, cacheKey: job.cacheKey, interval: config.interval, formats: config.formats });
      if (previous) {
        await d.discardJob(job);
        const result = { exitCode: 0, status: 'complete', reused: true, runId: previous.runId, outputDir: previous.outputDir, method: previous.method, timingPrecision: previous.timingPrecision, ...(previous.detectedLanguage ? { detectedLanguage: previous.detectedLanguage, languageNote: languageNote(previous.detectedLanguage) } : {}), message: `Такой результат уже есть: ${previous.outputDir}. Новая папка не создана.`, warnings: [] };
        emit(result); return result;
      }
      const cache = await d.readCache({ workRoot: config.workRoot, cacheKey: job.cacheKey });
      if (cache) return await complete(job, config, cache.transcript, cache.raw, 'cache');
      const subtitles = await d.getSourceTranscript(source, sourceOptions(config, job));
      if (subtitles && d.subtitlesSuitable(subtitles, { strategy: plan.strategy, diarize: config.diarize })) return await complete(job, config, subtitles, undefined, 'subtitles');
      if (!config.providers?.[config.provider]?.enabled) throw settingsRequired('PROVIDER_DISABLED', 'Выбранный провайдер отключён.', settingsPath);
      if (!flags['allow-cloud']) {
        try { await d.getProviderKey(config.provider, { credentialsFile: config.credentialsFile, ...(d.env ? { env: d.env } : {}) }); }
        catch { throw settingsRequired('KEY_REQUIRED', 'Ключ выбранного провайдера не настроен.', settingsPath); }
        throw fail('CLOUD_PERMISSION_REQUIRED', 'Подходящего локального результата нет. Для облачного распознавания требуется --allow-cloud.');
      }
      d.validateRecognition({ provider: config.provider, model: config.model, language: config.language });
      let request;
      try {
        request = await d.acquireRequest({ workRoot: config.workRoot, cacheKey: job.cacheKey, provider: config.provider });
      } catch (error) {
        if (error.code === 'CACHE_EXISTS') {
          const concurrent = await d.readCache({ workRoot: config.workRoot, cacheKey: job.cacheKey });
          if (concurrent) return await complete(job, config, concurrent.transcript, concurrent.raw, 'cache');
        }
        if (error.providerJob) { job.providerJob = error.providerJob; await d.saveJob(job); }
        if (error.code === 'REQUEST_UNCERTAIN') error.message += ` Если в кабинете сервиса видно, что запрос не обработан, блокировку снимает команда unlock ${job.runId} — только с согласия пользователя: возможна двойная оплата.`;
        throw error;
      }
      let attempted = false;
      try {
        let key;
        try { key = await d.getProviderKey(config.provider, { credentialsFile: config.credentialsFile, ...(d.env ? { env: d.env } : {}) }); }
        catch { throw settingsRequired('KEY_REQUIRED', 'Ключ выбранного провайдера не настроен.', settingsPath); }
        if (!prepared) { prepared = await d.prepareAudio(source, sourceOptions(config, job)); job.warnings.push(...(prepared.warnings || [])); }
        // Kept for resume: the AssemblyAI wait budget grows with the audio length.
        if (Number.isFinite(prepared.durationSeconds)) job.audioDurationSeconds = prepared.durationSeconds;
        await d.saveJob(job);
        await d.verifySource(source);
        await request.markAttempt(); attempted = true;
        job.status = 'processing'; await d.saveJob(job);
        const result = await d.transcribe({ provider: config.provider, key, filePath: prepared.audioPath, language: config.language, diarize: config.diarize, speakerCount: config.speakerCount, model: config.model, providerOptions: config.providerOptions, durationSeconds: prepared.durationSeconds, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), ...(d.signal ? { signal: d.signal } : {}), onResponse: raw => d.saveProviderResponse(job, raw), onSubmitted: async providerJob => {
          await request.markSubmitted(providerJob);
          job.providerJob = { id: providerJob.id, provider: providerJob.provider }; await d.saveJob(job);
        } });
        await d.saveProviderResponse(job, result.raw);
        const normalized = d.normalizeTranscript(result, { source: d.publicSource(source), language: config.language === 'auto' ? result.detectedLanguage ?? 'auto' : config.language, method: 'api', provider: config.provider, model: result.model, diarize: config.diarize, durationSeconds: result.durationSeconds ?? prepared.durationSeconds });
        return await complete(job, config, normalized, result.raw, 'api', () => request.markComplete());
      } catch (error) {
        if (error.providerJob?.provider === 'assemblyai') { job.providerJob = { id: error.providerJob.id, provider: 'assemblyai' }; await d.saveJob(job).catch(() => {}); }
        // Only a refusal before any provider job exists proves nothing was charged.
        const definitive = error.definitive === true && !error.providerJob && !request.record.providerJob;
        if (attempted && request.record.status !== 'complete') await request.markFailed({ definitive }).catch(() => {});
        if (attempted && !definitive && !error.providerJob && !request.record.providerJob && error.cliSafe) error.message += ` Если в кабинете сервиса видно, что запрос не обработан, блокировку снимает команда unlock ${job.runId} — только с согласия пользователя: возможна двойная оплата.`;
        if (error.code === 'PROVIDER_KEY_REJECTED') { const hint = settingsRequired(error.code, error.message, settingsPath); Object.assign(error, { message: hint.message, installerPath, settingsCommand: hint.settingsCommand }); }
        throw error;
      } finally { await request.release(); }
    }
    if (command === 'resume') {
      if (inputs.length !== 1) throw fail('CLI_ARGUMENT', 'resume требует один RUN_ID.');
      const initial = await resolve();
      job = await d.findJob({ workRoot: initial.workRoot, runId: inputs[0] });
      const recognition = Object.fromEntries(['language', 'provider', 'model', 'diarize', 'speakerCount', 'providerOptions'].filter(name => job.parameters[name] !== undefined).map(name => [name, job.parameters[name]]));
      const config = await resolve(recognition);
      const requestedSource = d.publicSource(job.source);
      emit({ status: flags.plan ? 'planned' : 'preview', runId: job.runId, source: requestedSource, parameters: publicParameters(config, flags) });
      if (flags.plan) return { exitCode: 0, status: 'planned', runId: job.runId, source: requestedSource, plan: publicParameters(config, flags) };
      const cache = job.cacheKey ? await d.readCache({ workRoot: config.workRoot, cacheKey: job.cacheKey }) : null;
      if (cache) return await complete(job, config, cache.transcript, cache.raw, 'cache');
      // A disk failure may leave a normalized response in jobDir even without cache.
      let saved;
      try { saved = JSON.parse(await readFile(path.join(job.jobDir, 'transcript.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved) {
        let raw; try { raw = JSON.parse(await readFile(path.join(job.jobDir, 'raw.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return await complete(job, config, saved, raw, 'cache');
      }
      const record = job.cacheKey ? await d.readRequest({ workRoot: config.workRoot, cacheKey: job.cacheKey }) : null;
      const providerJob = safeProviderJob(job.providerJob) || safeProviderJob(record?.providerJob);
      if (!providerJob) throw fail('REQUEST_UNCERTAIN', 'Сохранённого ID нет. Новая отправка запрещена; восстановите локальный результат.');
      job.providerJob = providerJob; await d.saveJob(job);
      if (!flags['allow-cloud']) throw fail('CLOUD_PERMISSION_REQUIRED', 'Для чтения существующего задания требуется --allow-cloud. Повторная отправка не выполняется.');
      if (!config.providers?.[providerJob.provider]?.enabled) throw fail('PROVIDER_DISABLED', 'Выбранный провайдер отключён.');
      const key = await d.getProviderKey(providerJob.provider, { credentialsFile: config.credentialsFile, ...(d.env ? { env: d.env } : {}) });
      const result = await d.resume({ ...providerJob, key, diarize: config.diarize, providerOptions: config.providerOptions, durationSeconds: job.audioDurationSeconds ?? job.source?.durationSeconds, onResponse: raw => d.saveProviderResponse(job, raw), ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), ...(d.signal ? { signal: d.signal } : {}) });
      await d.saveProviderResponse(job, result.raw);
      const normalized = d.normalizeTranscript(result, { source: d.publicSource(job.source), language: config.language === 'auto' ? result.detectedLanguage ?? 'auto' : config.language, provider: providerJob.provider, method: 'api', model: result.model, diarize: config.diarize, durationSeconds: result.durationSeconds });
      return await complete(job, config, normalized, result.raw, 'api');
    }
    if (command === 'reformat') {
      if (inputs.length !== 1) throw fail('CLI_ARGUMENT', 'reformat требует один PATH.');
      const config = await resolve(); const plan = publicParameters(config, flags);
      const requestedSource = previewSource(inputs[0], cwd);
      emit({ status: flags.plan ? 'planned' : 'preview', source: requestedSource, parameters: plan });
      if (flags.plan) return { exitCode: 0, status: 'planned', source: requestedSource, plan };
      const target = path.resolve(cwd, inputs[0]);
      let saved, file;
      try { file = (await stat(target)).isDirectory() ? path.join(target, 'transcript.json') : target; saved = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') throw fail('REFORMAT_INPUT', 'Укажите сохранённый transcript.json или папку результата: здесь его нет.'); throw error; }
      if (saved.schemaVersion !== 1 || typeof saved.text !== 'string') throw fail('REFORMAT_INPUT', 'Укажите сохранённый transcript.json или папку результата.');
      let raw; try { raw = JSON.parse(await readFile(path.join(path.dirname(file), 'raw.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      job = await d.createJob({ workRoot: config.workRoot, outputRoot: config.outputRoot, title: saved.source?.title, source: d.publicSource(saved.source), parameters: plan });
      return await complete(job, config, saved, raw, 'cache');
    }
    throw fail('CLI_COMMAND', 'Неизвестная команда. Используйте help.');
  } catch (error) {
    if (job) {
      job.status = 'failed'; await d.saveJob(job).catch(() => {});
      // The output folder is created early to catch a bad path before payment; rmdir removes it only while empty.
      await rmdir(job.outputDir).catch(() => {});
    }
    const providerJob = safeProviderJob(error.providerJob) || safeProviderJob(job?.providerJob);
    const system = error.cliSafe ? null : fileSystemError(error);
    const result = { exitCode: 1, status: 'failed', code: system?.code ?? (/^[A-Z][A-Z0-9_]*$/.test(error.code || '') ? error.code : 'CLI_FAILED'), message: error.cliSafe ? error.message : system?.message ?? 'Операция не завершена. Проверьте настройки и сохранённое задание; повторная облачная отправка автоматически не выполняется.', ...(error.installerPath ? { installerPath: error.installerPath, settingsCommand: error.settingsCommand } : {}), ...(job ? { runId: job.runId } : {}), ...(providerJob ? { providerJob } : {}) };
    errorOutput(result); return result;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await main()).exitCode;
