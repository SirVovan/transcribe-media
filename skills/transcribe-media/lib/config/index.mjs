import { readFile, mkdir, rename, writeFile, unlink, open, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Settings and key-store messages are fixed texts without values or paths, so the CLI and the wizard may show them.
export function configError(message, code = 'CONFIG_INVALID') { return Object.assign(new Error(message), { code, cliSafe: true, installerSafe: true }); }
const providers = ['deepgram', 'assemblyai'];
const envNames = { deepgram: 'DEEPGRAM_API_KEY', assemblyai: 'ASSEMBLYAI_API_KEY' };
function providerName(name) { if (!providers.includes(name)) throw configError('Неизвестный провайдер.'); return name; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function noSecrets(value) {
  if (!plain(value)) throw configError('Настройки должны быть объектом.');
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const secret = normalized === 'key' || /(?:apikey|accesskey|secretkey|token|password|secret|authorization|credentials)$/.test(normalized) || /^(deepgram|assemblyai).*key$/.test(normalized);
    if (['__proto__', 'constructor', 'prototype'].includes(key) || secret) throw configError('Настройки не могут содержать секреты.');
    if (plain(child)) noSecrets(child);
    if (Array.isArray(child)) for (const item of child) if (plain(item)) noSecrets(item);
  }
}
function merge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = plain(value) ? merge(plain(base[key]) ? base[key] : {}, value) : value;
  return result;
}
async function json(file) {
  try { const data = JSON.parse(await readFile(file, 'utf8')); if (!plain(data)) throw new Error(); return data; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw configError('Не удалось прочитать JSON настроек.'); }
}
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function defaultPaths({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const base = platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'transcribe-media')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'transcribe-media')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'transcribe-media');
  const data = platform === 'linux' ? path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'transcribe-media') : base;
  return { configPath: path.join(base, 'config.json'), credentialsFile: path.join(base, 'credentials.json'), outputRoot: path.join(home, 'Downloads'), workRoot: path.join(data, 'work') };
}
const defaults = () => ({ language: 'auto', interval: 30, formats: ['txt', 'srt', 'vtt'], provider: 'deepgram', diarize: false, speakerCount: 'auto', providers: { deepgram: { enabled: true }, assemblyai: { enabled: true } }, tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', node: 'node' }, ...defaultPaths() });
export async function resolveConfig({ configPath, projectConfigPath, overrides = {}, cwd = process.cwd() } = {}) {
  cwd = path.resolve(cwd);
  const user = await json(path.resolve(cwd, configPath || defaultPaths().configPath));
  const project = projectConfigPath ? await json(path.resolve(cwd, projectConfigPath)) : {};
  noSecrets(user); noSecrets(project); noSecrets(overrides);
  const result = merge(merge(merge(defaults(), user), project), overrides);
  if (typeof result.language !== 'string' || !result.language.trim()) throw configError('language должен быть непустой строкой.');
  if (!Number.isFinite(result.interval) || result.interval <= 0) throw configError('interval должен быть числом больше нуля.');
  if (!Array.isArray(result.formats) || !result.formats.length || result.formats.some(item => !['txt', 'srt', 'vtt'].includes(item))) throw configError('formats: выберите txt, srt или vtt.');
  result.formats = [...new Set(result.formats)]; providerName(result.provider);
  if (typeof result.diarize !== 'boolean') throw configError('diarize должен быть boolean.');
  if (result.speakerCount !== 'auto' && (!Number.isInteger(result.speakerCount) || result.speakerCount < 1)) throw configError('speakerCount: auto или положительное целое.');
  for (const name of providers) if (typeof result.providers[name]?.enabled !== 'boolean') throw configError('providers.enabled должен быть boolean.');
  for (const key of ['outputRoot', 'workRoot', 'credentialsFile']) result[key] = path.resolve(cwd, result[key]);
  for (const [key, value] of Object.entries(result.tools)) if (typeof value !== 'string' || !value) throw configError('Некорректный путь инструмента.'); else if (/[\\/]/.test(value)) result.tools[key] = path.resolve(cwd, value);
  if (result.sourceAccess?.cookiesFile) result.sourceAccess.cookiesFile = path.resolve(cwd, result.sourceAccess.cookiesFile);
  return result;
}
export async function saveConfig({ configPath = defaultPaths().configPath, patch, project = false } = {}) {
  noSecrets(patch); const file = path.resolve(configPath), lockFile = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true }); let lock; const deadline = Date.now() + 2000;
  try {
    while (!lock) {
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw configError('Настройки заняты другим процессом; повторите сохранение позже.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const current = await json(file); noSecrets(current);
    const result = merge(current, patch); await atomic(file, result); return result;
  } finally { if (lock) { await lock.close(); await unlink(lockFile); } }
}
export async function updateProvider(provider, { configPath, enabled, makeDefault, model } = {}) {
  providerName(provider); const settings = {};
  if (enabled !== undefined) { if (typeof enabled !== 'boolean') throw configError('enabled должен быть boolean.'); settings.enabled = enabled; }
  if (model !== undefined) { if (typeof model !== 'string' || !model.trim()) throw configError('Некорректная модель.'); settings.model = model; }
  return saveConfig({ configPath, patch: { providers: { [provider]: settings }, ...(makeDefault ? { provider } : {}) } });
}
async function restrictFile(file) {
  if ((await lstat(file)).isSymbolicLink()) throw configError('Хранилище ключей не может быть ссылкой.');
  if (process.platform !== 'win32') { await chmod(file, 0o600); return; }
  const script = '$ErrorActionPreference="Stop"; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow"); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($env:TRANSCRIBE_CREDENTIALS_TARGET,$acl)';
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, TRANSCRIBE_CREDENTIALS_TARGET: file } });
    child.on('error', () => reject(configError('Не удалось ограничить права хранилища ключей.')));
    child.on('exit', code => code === 0 ? resolve() : reject(configError('Не удалось ограничить права хранилища ключей.')));
  });
}
async function credentialsJson(file) {
  file = path.resolve(file);
  try {
    let component = path.parse(file).root;
    for (const name of file.slice(component.length).split(path.sep).filter(Boolean)) {
      component = path.join(component, name);
      if ((await lstat(component)).isSymbolicLink()) throw new Error();
    }
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw new Error();
    if (process.platform !== 'win32') { if ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw new Error(); }
    else {
      const script = '$ErrorActionPreference="Stop"; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.IO.File]::GetAccessControl($env:TRANSCRIBE_CREDENTIALS_TARGET); if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }; foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Value -ne $sid.Value) { exit 1 } }';
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, TRANSCRIBE_CREDENTIALS_TARGET: file } });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error()));
      });
    }
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1) throw new Error();
      const result = JSON.parse(await handle.readFile('utf8')); if (!plain(result)) throw new Error(); return result;
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return {}; throw configError('Не удалось прочитать защищённое хранилище ключей: проверьте права и ссылки.'); }
}
async function credentialsUpdate(file, change) {
  file = path.resolve(file); await mkdir(path.dirname(file), { recursive: true });
  let lock; const lockFile = `${file}.lock`; const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    lock = await open(lockFile, 'wx', 0o600);
    const result = change(await credentialsJson(file));
    const handle = await open(temporary, 'wx', 0o600); await handle.close();
    await restrictFile(temporary);
    await writeFile(temporary, JSON.stringify(result) + '\n', { mode: 0o600 }); await rename(temporary, file);
  } catch (error) { if (error.code === 'EEXIST') throw configError('Хранилище ключей занято другим процессом.'); throw error; }
  finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (lock) { await lock.close(); await unlink(lockFile); }
  }
}
export async function getProviderKey(provider, { credentialsFile = defaultPaths().credentialsFile, env = process.env } = {}) {
  providerName(provider); const environmentKey = env[envNames[provider]]?.trim(); if (environmentKey) return environmentKey;
  const key = (await credentialsJson(credentialsFile))[provider];
  if (typeof key !== 'string' || !key.trim()) throw new Error(`Не настроен ключ ${provider}.`); return key;
}
export async function setProviderKey(provider, key, { credentialsFile = defaultPaths().credentialsFile,expectedCredentialRevision } = {}) {
  providerName(provider); if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\x00]/.test(key)) throw configError('Некорректный ключ.');
  await credentialsUpdate(credentialsFile, current => {if(expectedCredentialRevision!==undefined&&(current._revisions?.[provider]||null)!==expectedCredentialRevision)throw Object.assign(new Error('Сохранённый ключ изменился. Повторите ввод и подтвердите замену.'),{code:'CREDENTIAL_STALE'});return { ...current, [provider]: key.trim(), _revisions: {...current._revisions, [provider]:randomUUID()} };});
}
export async function removeProviderKey(provider, { credentialsFile = defaultPaths().credentialsFile } = {}) {
  providerName(provider); await credentialsUpdate(credentialsFile, current => { delete current[provider]; current._revisions={...current._revisions,[provider]:randomUUID()}; return current; });
}
const environmentRevisions = new Map();
export async function getCredentialRevision(provider, {credentialsFile=defaultPaths().credentialsFile,env=process.env}={}) {
  providerName(provider);
  const environmentKey=env[envNames[provider]]?.trim();
  if(environmentKey){const previous=environmentRevisions.get(provider);if(!previous||previous.value!==environmentKey)environmentRevisions.set(provider,{value:environmentKey,revision:randomUUID()});return environmentRevisions.get(provider).revision;}
  environmentRevisions.delete(provider);
  const current=await credentialsJson(credentialsFile);
  if(typeof current._revisions?.[provider]==='string')return current._revisions[provider];
  if(typeof current[provider]!=='string'||!current[provider].trim())return null;
  let revision;
  await credentialsUpdate(credentialsFile,data=>{data._revisions={...data._revisions};revision=data._revisions[provider]||randomUUID();data._revisions[provider]=revision;return data;});
  return revision;
}
export async function providerStatus({ configPath = defaultPaths().configPath, projectConfigPath, credentialsFile = defaultPaths().credentialsFile } = {}) {
  const user = await json(path.resolve(configPath)), project = projectConfigPath ? await json(path.resolve(projectConfigPath)) : {};
  noSecrets(user); noSecrets(project);
  const config = merge(merge(defaults(), user), project); const keys = await credentialsJson(credentialsFile);
  return Object.fromEntries(providers.map(name => { const saved = typeof keys[name] === 'string' && !!keys[name].trim(); const enabled = config.providers[name].enabled;
    return [name, { enabled, saved, status: !enabled ? 'disabled' : saved ? 'saved' : 'unverified', verification: 'unverified' }]; }));
}
export function readHiddenKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw Object.assign(new Error('Нужен интерактивный терминал; введите ключ на странице настроек.'), { code: 'TTY_REQUIRED' });
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw; let key = ''; process.stderr.write('Введите ключ (ввод скрыт): ');
    const finish = (error) => { process.stdin.off('data', data); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(key); };
    const data = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\x03' || character === '\x04') return finish(Object.assign(new Error('Ввод отменён.'), { code: 'INPUT_CANCELLED' }));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\x7f' || character === '\b') key = key.slice(0, -1);
        else if (character >= ' ' && key.length < 8192) key += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data);
  });
}
export async function configureKey(provider, { credentialsFile, signal, replace = false, confirmReplace, onSaving, onSaved } = {}) {
  providerName(provider);
  signal?.throwIfAborted();
  const providerLabel = provider === 'deepgram' ? 'Deepgram' : 'AssemblyAI';
  const existing = !!(await credentialsJson(credentialsFile || defaultPaths().credentialsFile))[provider];
  const expectedCredentialRevision = await getCredentialRevision(provider, { credentialsFile, env: {} });
  process.stderr.write(`Ключ ${providerLabel} хранится для пользователя ОС. Установка в проект и --config не изолируют ключ.\n`);
  if (existing && !replace && !(await confirmReplace?.(provider))) throw Object.assign(new Error('Подтвердите замену сохранённого ключа.'), { code: 'REPLACE_REQUIRED' });
  const entered = await readHiddenKey(); signal?.throwIfAborted(); await onSaving?.();
  await setProviderKey(provider, entered, { credentialsFile, expectedCredentialRevision });
  const revision = await getCredentialRevision(provider, { credentialsFile, env: {} }); await onSaved?.({ saved: true, credentialRevision: revision });
  return { saved: true, verification: 'unverified', credentialRevision: revision };
}
