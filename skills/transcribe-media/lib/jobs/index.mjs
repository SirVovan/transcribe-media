import { mkdir, writeFile, readFile, rename, unlink, open, realpath, lstat, stat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
function keyName(key) { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Некорректный cacheKey.'); return key; }
// Coded failures carry only fixed texts, so the CLI may show them as is.
function failure(code, message, extras = {}) { const error = new Error(message); return Object.assign(error, { code, cliSafe: true }, extras); }
async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Повреждена локальная запись задания; повторная оплата запрещена.'); }
}
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function cacheKeyFor({ source, config }) {
  if (!source?.identity && !source?.fingerprint) throw new Error('Источник должен иметь identity или fingerprint.');
  const provider = config.provider;
  const identity = { type: source.type, identity: source.identity, fingerprint: source.fingerprint, durationSeconds: source.durationSeconds };
  const providerOptions = Object.fromEntries(Object.entries(config.providerOptions || {}).filter(([key]) => !['timeoutMs', 'pollTimeoutMs', 'pollIntervalMs'].includes(key)));
  const parameters = { provider, model: config.model ?? config.providers?.[provider]?.model, language: config.language, diarize: config.diarize, speakerCount: config.speakerCount, providerOptions };
  const credentialsFile = config.credentialsFile ? path.resolve(config.credentialsFile) : undefined;
  return createHash('sha256').update(JSON.stringify(stable({ source: identity, parameters, credentialsFile }))).digest('hex');
}
export async function readRequest({ workRoot, cacheKey }) { return json(path.join(path.resolve(workRoot), 'requests', `${keyName(cacheKey)}.json`)); }
export async function readCache({ workRoot, cacheKey }) {
  const dir = path.join(path.resolve(workRoot), 'cache', keyName(cacheKey)); const transcript = await json(path.join(dir, 'transcript.json'));
  if (!transcript) return null; const raw = await json(path.join(dir, 'raw.json')); return { transcript, ...(raw !== null ? { raw } : {}) };
}
export async function writeCache({ workRoot, cacheKey, transcript, raw }) {
  const dir = path.join(path.resolve(workRoot), 'cache', keyName(cacheKey));
  // Persist the provider response before formatting/output. A later output failure
  // can recover locally, while the payment record remains protected separately.
  if (raw !== undefined) await atomic(path.join(dir, 'raw.json'), raw);
  await atomic(path.join(dir, 'transcript.json'), transcript);
}
// EPERM: the process exists but belongs to another user, so it counts as alive.
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
// Locks of earlier versions are empty. A live writer fills the file within milliseconds and no
// earlier version kept a request open for an hour, so an empty lock that old is abandoned.
const LEGACY_LOCK_MS = 3600_000;
const lockedError = () => failure('REQUEST_LOCKED', 'Запрос занят другим процессом. Новый платный запрос запрещён.');
async function lockSnapshot(lockFile) {
  try { const [text, info] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]); return { text, mtimeMs: info.mtimeMs }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function abandoned(snapshot, isAlive) {
  let owner; try { owner = JSON.parse(snapshot.text); } catch { return Date.now() - snapshot.mtimeMs > LEGACY_LOCK_MS; }
  // A process on another computer (shared folder) cannot be checked.
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || owner.host !== os.hostname()) return false;
  try { return isAlive(owner.pid) === false; } catch { return false; }
}
// A forcibly killed process (e.g. an assistant timeout) leaves its lock behind. Its owner record
// lets the next run take the lock over; the payment record is still checked after that.
async function takeLock(root, cacheKey, isAlive = processAlive) {
  const lockFile = path.join(root, `${cacheKey}.lock`);
  const owner = { pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
  for (let attempt = 0; ; attempt++) {
    let handle;
    try { handle = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const snapshot = await lockSnapshot(lockFile);
      if (attempt > 0 || (snapshot && !abandoned(snapshot, isAlive))) throw lockedError();
      if (snapshot) await recoverLock(lockFile, snapshot);
      continue;
    }
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    let released = false;
    return async () => {
      if (released) return; released = true;
      const current = await lockSnapshot(lockFile);
      if (current) { let token; try { token = JSON.parse(current.text).token; } catch {} if (token === owner.token) await unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    };
  }
}
// The recovery file serialises takeovers, so two runs cannot both remove the same stale lock.
async function recoverLock(lockFile, snapshot) {
  const recoveryFile = `${lockFile}.recovery`; let recovery;
  try { recovery = await open(recoveryFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const left = await lockSnapshot(recoveryFile);
    if (left && Date.now() - left.mtimeMs > 60_000) await unlink(recoveryFile).catch(() => {});
    throw lockedError();
  }
  try { const current = await lockSnapshot(lockFile); if (current?.text === snapshot.text) await unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  finally { await recovery.close(); await unlink(recoveryFile).catch(() => {}); }
}
export async function acquireRequest({ workRoot, cacheKey, provider, isAlive }) {
  if (!['deepgram', 'assemblyai'].includes(provider)) throw new Error('Неизвестный провайдер.');
  const root = path.join(path.resolve(workRoot), 'requests'); await mkdir(root, { recursive: true });
  const file = path.join(root, `${keyName(cacheKey)}.json`);
  const releaseLock = await takeLock(root, cacheKey, isAlive);
  let released = false;
  const release = async () => { if (!released) { released = true; await releaseLock(); } };
  try {
    if (await readCache({ workRoot, cacheKey })) throw failure('CACHE_EXISTS', 'Результат уже находится в локальном кэше.');
    const existing = await json(file);
    if (existing?.providerJob?.provider === 'assemblyai' && existing.providerJob.id && existing.status !== 'complete') throw failure('REQUEST_RESUME', 'Продолжите существующее задание AssemblyAI без повторной оплаты.', { providerJob: { id: existing.providerJob.id, provider: 'assemblyai' } });
    if (existing?.status === 'complete') throw failure('REQUEST_COMPLETE', 'Платный запрос уже завершён; восстановите сохранённый результат.');
    if (existing && !['pending', 'failed'].includes(existing.status)) throw failure('REQUEST_UNCERTAIN', 'Результат прежней отправки неопределён. Новый платный запрос запрещён.');
    if (existing?.status === 'failed' && !existing.definitive) throw failure('REQUEST_UNCERTAIN', 'Результат отправки неопределён.');
    const record = { schemaVersion: 1, cacheKey, provider, status: 'pending', createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    await atomic(file, record);
    const change = async patch => { if (released) throw new Error('Блокировка запроса уже освобождена.'); Object.assign(record, patch, { updatedAt: new Date().toISOString() }); await atomic(file, record); };
    return { record,
      async markAttempt() { if (record.status !== 'pending') throw failure('REQUEST_UNCERTAIN', 'Повторный POST в этом запуске запрещён.'); await change({ status: 'uncertain', attemptedAt: new Date().toISOString() }); },
      async markSubmitted(providerJob) { if (providerJob?.provider !== 'assemblyai' || typeof providerJob.id !== 'string' || !providerJob.id || providerJob.id.length > 512) throw new Error('Некорректный providerJob.'); await change({ status: 'submitted', providerJob: { id: providerJob.id, provider: 'assemblyai' } }); },
      async markComplete() { await change({ status: 'complete' }); },
      async markFailed({ definitive = false } = {}) { await change({ status: definitive ? 'failed' : 'uncertain', definitive: !!definitive }); },
      release
    };
  } catch (error) { await release(); throw error; }
}
// Lifting an uncertain block is the user's decision: the service may have processed and charged
// the request, and a new submission would be paid again.
export async function unlockRequest({ workRoot, cacheKey, confirmUncertain = false, isAlive }) {
  const root = path.join(path.resolve(workRoot), 'requests'); const file = path.join(root, `${keyName(cacheKey)}.json`);
  if (!(await json(file))) return { status: 'not-blocked' };
  const releaseLock = await takeLock(root, cacheKey, isAlive);
  try {
    const record = await json(file); const previousStatus = record.status;
    if (record.status === 'complete') throw failure('REQUEST_COMPLETE', 'Платный запрос уже завершён; повторите transcribe — результат возьмётся из кэша без оплаты.');
    if (record.providerJob?.provider === 'assemblyai' && record.providerJob.id) throw failure('REQUEST_RESUME', 'У AssemblyAI есть сохранённое задание: продолжите его командой resume без повторной оплаты.', { providerJob: { id: record.providerJob.id, provider: 'assemblyai' } });
    if (record.status === 'pending' || (record.status === 'failed' && record.definitive)) return { status: 'not-blocked', previousStatus };
    if (!confirmUncertain) return { status: 'confirmation-required', previousStatus };
    const now = new Date().toISOString();
    await atomic(file, { ...record, status: 'failed', definitive: true, unlockedAt: now, unlockedFrom: previousStatus, updatedAt: now });
    return { status: 'unlocked', previousStatus };
  } finally { await releaseLock(); }
}
function inside(root, target) { const relative = path.relative(root, target); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function rejectLinks(target) {
  target = path.resolve(target); const parsed = path.parse(target); let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Ссылка или junction во временном пути запрещена.');
  }
  return realpath(target);
}
function jobPaths(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.runId) || path.basename(job.jobDir) !== job.runId || path.basename(path.dirname(job.jobDir)) !== 'jobs' || path.resolve(job.tempDir) !== path.join(path.resolve(job.jobDir), 'temp')) throw new Error('Некорректный tempDir задания.');
}
async function safeTemp(job, file) {
  jobPaths(job); const base = path.resolve(job.tempDir); const target = path.resolve(file);
  if (!inside(base, target)) throw new Error('Файл находится за пределами tempDir.');
  const baseReal = await rejectLinks(base); const targetReal = await rejectLinks(target);
  if (!inside(baseReal, targetReal)) throw new Error('Временный путь выходит за пределы tempDir.');
  if (!(await lstat(target)).isFile()) throw new Error('Уборка допускает только временные файлы.');
  return target;
}
import { publicSource } from '../sources/public-source.mjs';
import { link as linkReceipt, unlink as unlinkReceipt } from 'node:fs/promises';
function publicParameters(value) {
  if (Array.isArray(value)) return value.map(publicParameters);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api[-_]?key|key|token|password|secret|authorization|credentials|cookies|cookiesFile|cookiesBrowser)$/i.test(key)).map(([key, child]) => [key, publicParameters(child)]));
  return value;
}
export async function createJob({ workRoot, outputRoot, title = 'transcript', source, parameters = {} }) {
  const runId = randomUUID(); const jobDir = path.join(path.resolve(workRoot), 'jobs', runId); const tempDir = path.join(jobDir, 'temp');
  let basename = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'transcript';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) basename = `_${basename}`;
  // TRANSCRIPT_<title>, then "(2)", "(3)", … (user decision 16.10); mkdir without recursive claims a free name atomically.
  await mkdir(tempDir, { recursive: true }); await mkdir(path.resolve(outputRoot), { recursive: true });
  let outputDir;
  for (let number = 1; !outputDir; number++) {
    const candidate = path.join(path.resolve(outputRoot), `TRANSCRIPT_${basename}${number > 1 ? ` (${number})` : ''}`);
    try { await mkdir(candidate); outputDir = candidate; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const job = { schemaVersion: 1, runId, source, parameters, outputDir, fileBase: basename, jobDir, tempDir, createdFiles: [], status: 'created', warnings: [] };
  await saveJob(job); return job;
}
export async function saveJob(job) {
  jobPaths(job); await atomic(path.join(job.jobDir, 'job.json'), { ...job, source: publicSource(job.source), parameters: publicParameters(job.parameters) });
}
export async function findJob({ workRoot, runId }) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw failure('JOB_NOT_FOUND', 'Некорректный RUN_ID: нужен идентификатор из ответа transcribe (runId).');
  const jobDir = path.join(path.resolve(workRoot), 'jobs', runId); const job = await json(path.join(jobDir, 'job.json'));
  if (!job) throw failure('JOB_NOT_FOUND', 'Задание с таким RUN_ID не найдено в рабочей папке.');
  if (path.resolve(job.jobDir) !== jobDir) throw new Error('Путь задания не соответствует workRoot.'); jobPaths(job); return job;
}
export async function registerTemp(job, file) {
  const target = await safeTemp(job, file); if (!job.createdFiles.includes(target)) job.createdFiles.push(target); await saveJob(job);
}
export async function cleanupJob(job, { dryRun = false, keepTemp = false } = {}) {
  jobPaths(job); const files = []; const removed = []; const warnings = [];
  if (keepTemp) return { files, removed, warnings };
  for (const file of [...new Set(job.createdFiles)]) {
    try {
      const target = await safeTemp(job, file); files.push(target);
      if (!dryRun) { await safeTemp(job, target); await unlink(target); removed.push(target); }
    } catch (error) { if (error.code !== 'ENOENT') warnings.push('Временный файл не удалён: путь не прошёл проверку или файл недоступен.'); }
  }
  if (!dryRun) {
    job.createdFiles = job.createdFiles.filter(file => !removed.includes(file)); job.warnings = [...new Set([...(job.warnings || []), ...warnings])];
    try { await saveJob(job); } catch { warnings.push('Не удалось записать состояние уборки; результат сохранён.'); }
  }
  return { files, removed, warnings };
}
export async function saveProviderResponse(job, raw) {
  jobPaths(job);
  const file = path.join(job.jobDir, 'raw.json'), temporary = path.join(job.jobDir, `raw-${randomUUID()}.json`);
  try {
    await atomic(temporary, raw);
    try { await linkReceipt(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (JSON.stringify(await json(file)) !== JSON.stringify(raw)) throw new Error('Ответ провайдера уже сохранён; перезапись запрещена.');
    }
  } finally { await unlinkReceipt(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
// Text and subtitle files carry the title; folders made before 16.10 have no fileBase and keep transcript.*.
export function resultFile(job, format) { return `${job.fileBase || 'transcript'}.${format}`; }
export async function saveResult(job, { transcript, files, raw, source }) {
  jobPaths(job);
  if (Object.keys(files || {}).some(file => !['transcript.txt', 'transcript.srt', 'transcript.vtt'].includes(file))) throw new Error('Недопустимый файл результата.');
  const publicDescription = publicSource(source ?? job.source);
  if (raw !== undefined) await atomic(path.join(job.jobDir, 'raw.json'), raw);
  await atomic(path.join(job.jobDir, 'transcript.json'), { ...transcript, source: publicDescription });
  await mkdir(job.outputDir, { recursive: true });
  if (raw !== undefined) await atomic(path.join(job.outputDir, 'raw.json'), raw);
  await atomic(path.join(job.outputDir, 'transcript.json'), { ...transcript, source: publicDescription });
  await atomic(path.join(job.outputDir, 'source.json'), publicDescription);
  for (const [file, text] of Object.entries(files || {})) await writeFile(path.join(job.outputDir, resultFile(job, path.extname(file).slice(1))), text, { encoding: 'utf8', mode: 0o600 });
  job.status = 'complete'; job.warnings = [...new Set([...(job.warnings || []), ...(transcript.warnings || [])])]; await saveJob(job);
  await atomic(path.join(job.outputDir, 'job.json'), { ...job, source: publicDescription, parameters: publicParameters(job.parameters) });
}
// Sweep of earlier runs. Kept: runs in progress, records an uncertain payment or an AssemblyAI
// job depends on (unlock/resume need them), unsaved provider results, results and settings.
// A completed payment record goes together with its expired cache: alone it would block the file.
const DAY_MS = 86_400_000;
const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Result folders: TRANSCRIPT_<title> since 16.10, <title>-<runId> before.
const OUTPUT_DIR = /^TRANSCRIPT_|-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SWEEP_LABELS = { temp: 'Временные файлы прошлых запусков', job: 'Служебные папки прошлых запусков', cache: 'Кэш старше 14 дней', request: 'Записи об оплаченных запросах без кэша', output: 'Пустые папки результатов' };
async function entries(dir) { return readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); }
async function sizeOf(target) {
  let info; try { info = await lstat(target); } catch { return 0; }
  if (!info.isDirectory()) return info.size;
  let total = 0; for (const entry of await entries(target)) total += await sizeOf(path.join(target, entry.name)); return total;
}
function megabytes(bytes) { return `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ`; }
export async function cleanupWork({ workRoot, outputRoot, dryRun = false, now = Date.now(), cacheMaxAgeMs = 14 * DAY_MS, activeMs = 3_600_000, isAlive = processAlive }) {
  workRoot = path.resolve(workRoot); const requestsDir = path.join(workRoot, 'requests');
  const found = []; const warnings = [];
  const modified = async target => (await stat(target)).mtimeMs;
  const exists = target => lstat(target).then(() => true, () => false);
  const locked = async key => { const snapshot = await lockSnapshot(path.join(requestsDir, `${key}.lock`)); return !!snapshot && !abandoned(snapshot, isAlive); };
  const records = new Map();
  for (const entry of await entries(requestsDir)) {
    const match = entry.isFile() && entry.name.match(/^([a-f0-9]{64})\.json$/); if (!match) continue;
    try { records.set(match[1], await json(path.join(requestsDir, entry.name))); } catch { warnings.push(`Запись журнала оплат повреждена и не тронута: ${entry.name}`); }
  }
  // A completed record keeps its AssemblyAI ID, but nothing needs it any more.
  const needed = record => !!record && record.status !== 'complete' && (!!record.providerJob?.id || !['pending', 'failed'].includes(record.status) || (record.status === 'failed' && !record.definitive));
  for (const entry of await entries(path.join(workRoot, 'jobs'))) {
    if (!entry.isDirectory() || !RUN_DIR.test(entry.name)) continue;
    const jobDir = path.join(workRoot, 'jobs', entry.name); let job;
    try { job = await json(path.join(jobDir, 'job.json')); } catch { warnings.push(`Запись запуска повреждена, папка не тронута: ${jobDir}`); continue; }
    if (!job || path.resolve(String(job.jobDir)) !== jobDir) continue;
    if (now - await modified(path.join(jobDir, 'job.json')) < activeMs || (job.cacheKey && await locked(job.cacheKey))) continue;
    const unsaved = job.status !== 'complete' && (await exists(path.join(jobDir, 'transcript.json')) || await exists(path.join(jobDir, 'raw.json')));
    if (!needed(job.cacheKey && records.get(job.cacheKey)) && !(job.providerJob && job.status !== 'complete') && !unsaved) { found.push({ kind: 'job', path: jobDir }); continue; }
    for (const file of await entries(path.join(jobDir, 'temp'))) if (file.isFile()) found.push({ kind: 'temp', path: path.join(jobDir, 'temp', file.name) });
  }
  const cacheRoot = path.join(workRoot, 'cache');
  for (const entry of await entries(cacheRoot)) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    let time; try { time = await modified(path.join(cacheRoot, entry.name, 'transcript.json')); } catch { continue; }
    if (now - time <= cacheMaxAgeMs || await locked(entry.name)) continue;
    found.push({ kind: 'cache', path: path.join(cacheRoot, entry.name) });
    if (records.get(entry.name)?.status === 'complete') found.push({ kind: 'request', path: path.join(requestsDir, `${entry.name}.json`) });
  }
  for (const [key, record] of records) {
    if (record?.status !== 'complete' || await exists(path.join(cacheRoot, key)) || await locked(key)) continue;
    found.push({ kind: 'request', path: path.join(requestsDir, `${key}.json`) });
  }
  if (outputRoot) for (const entry of await entries(path.resolve(outputRoot))) {
    if (!entry.isDirectory() || !OUTPUT_DIR.test(entry.name)) continue;
    const dir = path.join(path.resolve(outputRoot), entry.name);
    if ((await entries(dir)).length || now - await modified(dir) < activeMs) continue;
    found.push({ kind: 'output', path: dir });
  }
  const items = [];
  for (const item of found) {
    item.bytes = await sizeOf(item.path);
    if (!dryRun) {
      try {
        if (item.kind === 'output') await rmdir(item.path);
        else if (item.kind === 'job' || item.kind === 'cache') { if (!inside(workRoot, item.path)) throw new Error(); await rm(item.path, { recursive: true }); }
        else await unlink(item.path);
      } catch { warnings.push(`Не удалось удалить: ${item.path}`); continue; }
    }
    items.push(item);
  }
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const summary = Object.entries(SWEEP_LABELS).map(([kind, label]) => { const group = items.filter(item => item.kind === kind); return group.length ? `${label}: ${group.length}, ${megabytes(group.reduce((sum, item) => sum + item.bytes, 0))}` : null; }).filter(Boolean);
  return { items, totalBytes, total: megabytes(totalBytes), summary, warnings };
}
// A repeat with the same request and formatting names the earlier result folder instead of making a copy
// (user decision 16.10). The folders themselves are searched, so this works after cleanupWork too.
export async function findResult({ outputRoot, cacheKey, interval, formats }) {
  keyName(cacheKey); const root = path.resolve(outputRoot); const wanted = [...formats].sort().join(); let best = null;
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || !OUTPUT_DIR.test(entry.name)) continue;
    const dir = path.join(root, entry.name); let job;
    try { job = await json(path.join(dir, 'job.json')); } catch { continue; }
    // No fileBase: made before 16.10 with transcript.* names and the old caption cut — rebuild instead.
    if (job?.status !== 'complete' || !job.fileBase || job.cacheKey !== cacheKey || job.parameters?.interval !== interval || !Array.isArray(job.parameters?.formats) || [...job.parameters.formats].sort().join() !== wanted) continue;
    const files = await Promise.all(['transcript.json', ...formats.map(format => resultFile(job, format))].map(file => lstat(path.join(dir, file)).then(info => info.isFile(), () => false)));
    if (!files.every(Boolean)) continue;
    const time = (await stat(path.join(dir, 'job.json'))).mtimeMs;
    if (!best || time > best.time) best = { time, outputDir: dir, runId: job.runId };
  }
  if (!best) return null;
  let transcript = null; try { transcript = await json(path.join(best.outputDir, 'transcript.json')); } catch {}
  return { outputDir: best.outputDir, runId: best.runId, method: transcript?.method, timingPrecision: transcript?.timingPrecision, ...(typeof transcript?.detectedLanguage === 'string' ? { detectedLanguage: transcript.detectedLanguage } : {}) };
}
// Removes a run that turned out unnecessary: its output folder is still empty, its work folder holds only temp files.
export async function discardJob(job) {
  jobPaths(job);
  await rmdir(job.outputDir).catch(() => {});
  await rm(job.jobDir, { recursive: true, force: true });
}
// Recent runs for the assistant: the run ID resume, unlock and cleanup need, and which of them a run needs.
export async function listJobs({ workRoot, limit = 20 }) {
  workRoot = path.resolve(workRoot); const jobs = [];
  for (const entry of await entries(path.join(workRoot, 'jobs'))) {
    if (!entry.isDirectory() || !RUN_DIR.test(entry.name)) continue;
    const file = path.join(workRoot, 'jobs', entry.name, 'job.json'); let job;
    try { job = await json(file); } catch { continue; }
    if (!job || job.runId !== entry.name) continue;
    let record = null; if (job.cacheKey) { try { record = await readRequest({ workRoot, cacheKey: job.cacheKey }); } catch {} }
    const open = job.status !== 'complete';
    const resume = open && (!!job.providerJob?.id || (!!record?.providerJob?.id && record.status !== 'complete'));
    const unlock = open && !resume && !!record && (!['pending', 'failed', 'complete'].includes(record.status) || (record.status === 'failed' && !record.definitive));
    jobs.push({ runId: job.runId, title: job.source?.title, status: job.status, updatedAt: new Date((await stat(file)).mtimeMs).toISOString(), ...(job.status === 'complete' ? { outputDir: job.outputDir } : {}), ...(resume ? { action: 'resume' } : unlock ? { action: 'unlock' } : {}) });
  }
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { jobs: jobs.slice(0, limit), total: jobs.length };
}
