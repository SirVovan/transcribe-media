import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { lstat, readdir, mkdir, copyFile, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
const processOptions = { shell: false, windowsHide: true };
// Тексты ошибок установки заданы здесь и не содержат секретов, поэтому их можно показывать пользователю.
function fail(code, message) { const error = new Error(message); error.code = code; error.installerSafe = true; error.cliSafe = true; return error; }
export const toolTitles = { node: 'Node.js', ffmpeg: 'FFmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp' };
export const ejsWarning = 'YouTube-ссылки работать не будут: у yt-dlp нет компонента EJS, который проходит проверку YouTube на JavaScript. Локальные файлы, TikTok и Instagram работают.';
const hostOf = url => { try { return new URL(url).host; } catch { return 'источника'; } };
async function progress(onProgress,event){if(onProgress)await onProgress({stage:'install',timestamp:new Date().toISOString(),...event});}
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 30000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, ...processOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    // Долгие установщики (winget) печатают много прогресса: храним только хвост вывода, процесс не обрываем.
    const append = (stream, chunk) => { if (options.tailOnly) { if (stream === 'stdout') stdout = (stdout + chunk).slice(-65536); else stderr = (stderr + chunk).slice(-65536); return; } size += chunk.length; if (size > 2_000_000) { child.kill(); return; } if (stream === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', chunk => append('stdout', chunk)); child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function toolPaths(tools = {}) {
  return { node: tools.node && tools.node !== 'node' ? tools.node : process.execPath, ffmpeg: tools.ffmpeg || 'ffmpeg', ffprobe: tools.ffprobe || 'ffprobe', ytdlp: tools.ytdlp || 'yt-dlp' };
}
const executables = { node: 'node', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp' };
// Пакеты winget, которые ставит этот установщик; их папки проверяются при поиске уже установленных программ.
export const wingetPackages = { node: 'OpenJS.NodeJS.LTS', ffmpeg: 'Gyan.FFmpeg.Essentials', ytdlp: 'yt-dlp.yt-dlp' };
const wingetFolders = ['Gyan.FFmpeg', 'yt-dlp.FFmpeg', 'yt-dlp.yt-dlp', 'OpenJS.NodeJS'];
// Программа может быть установлена, но не видна текущему процессу через PATH: winget, Chocolatey, Scoop, установщик Node.js
// и прежние версии этого установщика кладут её в известные места.
// Формулы Homebrew для macOS; yt-dlp из Homebrew уже содержит EJS и ставит Deno.
export const brewFormulas = { node: 'node', ffmpeg: 'ffmpeg', ytdlp: 'yt-dlp' };
// macOS: приложения из Dock и Finder не видят PATH терминала, поэтому ищем в папках Homebrew, MacPorts, pip и прежних версий.
async function macLocations(name, { env, home }) {
  const exe = executables[name], list = [];
  for (const prefix of [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local', '/opt/local'].filter(Boolean)) list.push(path.join(prefix, 'bin', exe));
  if (home) list.push(path.join(home, '.local', 'bin', exe));
  if (home && name === 'ytdlp') {
    const python = path.join(home, 'Library', 'Python');
    for (const version of await readdir(python).catch(() => [])) list.push(path.join(python, version, 'bin', exe));
  }
  if (home) {
    const tools = path.join(home, 'Library', 'Application Support', 'transcribe-media', 'tools');
    if (name === 'node') { const saved = (await readFile(path.join(tools, 'node-path.txt'), 'utf8').catch(() => '')).trim(); if (saved) list.push(saved); }
    else list.push(path.join(tools, exe));
  }
  return [...new Set(list)];
}
async function knownLocations(name, { platform, env, home = os.homedir() }) {
  if (platform === 'darwin') return macLocations(name, { env, home: env.HOME || home });
  if (platform !== 'win32') return [];
  const exe = executables[name] + '.exe', list = [], local = env.LOCALAPPDATA;
  if (local) list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe));
  if (name === 'node') for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) list.push(path.join(root, 'nodejs', 'node.exe'));
  if (env.ProgramData) list.push(path.join(env.ProgramData, 'chocolatey', 'bin', exe));
  if (env.USERPROFILE) list.push(path.join(env.USERPROFILE, 'scoop', 'shims', exe));
  if (local) list.push(path.join(local, 'transcribe-media', 'tools', exe));
  if (local) {
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    let entries = []; try { entries = await readdir(packages, { withFileTypes: true }); } catch { /* winget ещё ничего не ставил */ }
    for (const entry of entries) if (entry.isDirectory() && wingetFolders.some(prefix => entry.name.startsWith(prefix + '_'))) { const match = await findExecutable(path.join(packages, entry.name), exe, 3).catch(() => null); if (match) list.push(match); }
  }
  return list;
}
async function checkTool(name, command, run) {
  try {
    const result = await run(command, [name === 'ffmpeg' || name === 'ffprobe' ? '-version' : '--version'], processOptions);
    const version = String(result.stdout).match(name === 'ytdlp' ? /\d{4}\.\d{2}\.\d{2}/ : /\d+(?:\.\d+){1,2}/)?.[0];
    // Номер выпуска FFmpeg есть только у релизных сборок («ffmpeg version 8.1.1-…»); у ночных сборок версию сравнить не с чем.
    const release = name === 'ffmpeg' ? String(result.stdout).match(/^ffmpeg version n?(\d+(?:\.\d+){1,2})/m)?.[1] : undefined;
    return { path: command, version: version || null, ...(release ? { release } : {}), status: result.code !== 0 || !version ? 'unusable' : name === 'node' && Number(version.split('.')[0]) < 22 ? 'outdated' : 'available' };
  } catch { return { path: command, version: null, status: 'missing' }; }
}
export async function locateTool(name, command, { runProcess: run = runProcess, platform = process.platform, env = process.env } = {}) {
  const first = await checkTool(name, command, run);
  if (first.status === 'available') return first;
  for (const candidate of await knownLocations(name, { platform, env })) {
    if (candidate === command || !await exists(candidate).catch(() => null)) continue;
    const found = await checkTool(name, candidate, run);
    if (found.status === 'available') return { ...found, foundIn: 'known-location' };
  }
  return first;
}
// Последние версии берутся из списков выпусков самих разработчиков. Читаются только при checkUpdates (установка, обновление, doctor).
const latestSources = {
  ytdlp: { url: 'https://pypi.org/pypi/yt-dlp/json', read: data => data?.info?.version },
  node: { url: 'https://nodejs.org/dist/index.json', read: data => Array.isArray(data) ? data.find(item => item?.lts)?.version : null },
  ffmpeg: { url: 'https://www.gyan.dev/ffmpeg/builds/release-version', text: true, read: text => text }
};
const brewSource = formula => ({ url: `https://formulae.brew.sh/api/formula/${formula}.json`, read: data => data?.versions?.stable });
const versionParts = value => String(value || '').replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
export function isNewer(latest, current) {
  const a = versionParts(latest), b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
async function latestVersion(source, fetchImpl) {
  try {
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const value = String(source.read(source.text ? await response.text() : await response.json()) || '').trim().replace(/^v/i, '');
    return /^\d+(?:\.\d+)+$/.test(value) ? value : null;
  } catch { return null; }
}
// Устаревшие программы: yt-dlp ломается при изменениях сайтов, поэтому сверяется и он, и Node.js с FFmpeg (решение пользователя 17.10).
async function checkLatest(found, { platform, fetchImpl }) {
  const updates = [];
  for (const name of ['ytdlp', 'node', 'ffmpeg']) {
    const tool = found[name], current = name === 'ffmpeg' ? tool.release : tool.version;
    // Linux пока ставит программы в личную папку и сверяет только yt-dlp.
    if (tool.status !== 'available' || !current || platform === 'linux' && name !== 'ytdlp') continue;
    // Пакет winget вида OpenJS.NodeJS.22 держит одну линию Node.js: сверяем с последней версией этой линии.
    const line = name === 'node' && tool.wingetId?.match(/^OpenJS\.NodeJS\.(\d+)$/)?.[1];
    const source = line ? { url: latestSources.node.url, read: data => Array.isArray(data) ? data.find(item => String(item?.version).startsWith(`v${line}.`))?.version : null } : platform === 'darwin' && (name === 'ffmpeg' || brewOwned(tool.location)) ? brewSource(brewFormulas[name]) : latestSources[name];
    const latest = await latestVersion(source, fetchImpl);
    if (!latest) continue;
    tool.latest = latest;
    if (line) { const lts = await latestVersion(latestSources.node, fetchImpl); if (lts && isNewer(lts, latest)) tool.newerLts = lts; }
    if (isNewer(latest, current)) updates.push({ tool: name, current, latest });
  }
  return updates;
}
export const impersonateWarning = 'Часть сайтов (например, TikTok) может не открываться: у yt-dlp нет модуля curl_cffi, который выдаёт запросы за браузер.';
export async function inspectDependencies({ tools = {}, runProcess: run = runProcess, platform = process.platform, arch = process.arch, env = process.env, onProgress, checkUpdates = false, fetchImpl = fetch } = {}) {
  const paths = toolPaths(tools), found = {};
  for (const [name, command] of Object.entries(paths)) {
    await progress(onProgress,{stage:'inspect',tool:name,operation:'check',status:'running'});
    found[name] = await locateTool(name, command, { runProcess: run, platform, env });
    await progress(onProgress,{stage:'inspect',tool:name,operation:'check',status:found[name].status});
  }
  let ejs = 'unknown';
  if (found.ytdlp.status === 'available') {
    try {
      // Заголовок --verbose со списком библиотек печатается только при обработке адреса; about:invalid не требует сети и завершается кодом 1.
      const result = await run(found.ytdlp.path, ['--ignore-config', '--no-plugin-dirs', '--verbose', '--js-runtimes', `node:${found.node.path}`, '--simulate', 'about:invalid'], processOptions);
      const output = result.stderr + result.stdout;
      ejs = /(?:yt_dlp_ejs|yt-dlp-ejs)[-=: ]\S+/i.test(output) ? 'available' : /Optional libraries/i.test(output) ? 'missing' : 'unknown';
      // Способ установки yt-dlp (pip, win_exe…) определяет рекомендованный путь обновления.
      found.ytdlp.variant = output.match(/yt-dlp version \S+ from \S+ \[\w+\] \(([\w-]+)\)/)?.[1] || null;
    } catch { ejs = 'unknown'; }
    // curl_cffi: без него TikTok отвечает «Unexpected response» (17.10). Список целей печатается без обращения к сети.
    try {
      const result = await run(found.ytdlp.path, ['--ignore-config', '--no-plugin-dirs', '--list-impersonate-targets'], processOptions);
      const lines = String(result.stdout + result.stderr).split(/\r?\n/);
      found.ytdlp.impersonate = !lines.some(line => /impersonate targets/i.test(line)) ? 'unknown' : lines.some(line => /curl_cffi/i.test(line) && !/unavailable/i.test(line)) ? 'available' : 'missing';
    } catch { found.ytdlp.impersonate = 'unknown'; }
  }
  let winget = null;
  if (platform === 'win32') {
    // Где лежит программа, найденная по имени: по папке пакета winget выбирается, какой пакет обновлять.
    for (const name of ['ytdlp', 'ffmpeg']) if (found[name].status === 'available' && !path.isAbsolute(found[name].path)) found[name].location = await onPath(found[name].path, env);
    winget = { status: 'missing', path: null };
    for (const command of ['winget', ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')] : [])]) {
      const result = await run(command, ['--version'], processOptions).catch(() => null);
      if (result?.code === 0) { winget = { status: 'available', path: command, version: String(result.stdout).trim() || null }; break; }
    }
    // Под каким пакетом winget стоит Node.js (OpenJS.NodeJS.LTS, линия OpenJS.NodeJS.22…): обновлять можно только его (17.10).
    if (checkUpdates && winget.status === 'available' && found.node.status === 'available') {
      const list = await run(winget.path, ['list', '--id', 'OpenJS.NodeJS', '--accept-source-agreements', '--disable-interactivity'], processOptions).catch(() => null);
      found.node.wingetId = String(list?.stdout || '').match(/OpenJS\.NodeJS(?:\.\w+)?/)?.[0] || null;
    }
  }
  let brew = null;
  if (platform === 'darwin') {
    brew = { status: 'missing', path: null };
    for (const command of ['brew', ...[env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean).map(prefix => path.join(prefix, 'bin', 'brew'))]) {
      const result = await run(command, ['--version'], processOptions).catch(() => null);
      if (result?.code === 0) { brew = { status: 'available', path: command, version: String(result.stdout).match(/\d+\.\d+\.\d+/)?.[0] || null }; break; }
    }
    // Где лежат найденные программы: от этого зависит способ обновления (Homebrew, pip или отдельный файл).
    for (const name of ['ytdlp', 'node', 'ffmpeg']) if (found[name].status === 'available') {
      const where = path.isAbsolute(found[name].path) ? found[name].path : String((await run('which', [found[name].path], processOptions).catch(() => null))?.stdout || '').trim().split(/\r?\n/)[0] || null;
      found[name].location = where;
    }
  }
  const nodeRuntime = found.node.status === 'available' ? 'available' : 'unavailable';
  const youtube = { nodeRuntime, ejs, status: nodeRuntime === 'available' && ejs === 'available' ? 'available' : 'unavailable', args: ['--js-runtimes', `node:${found.node.path}`] };
  await progress(onProgress,{stage:'inspect',tool:'youtube',operation:'check',status:youtube.status});
  const updates = checkUpdates ? await checkLatest(found, { platform, fetchImpl }) : [];
  // refresh — что стоит обновить, хотя программы работают: устаревшие версии и yt-dlp без curl_cffi.
  const refresh = [...new Set([...updates.map(item => item.tool), ...(found.ytdlp.impersonate === 'missing' ? ['ytdlp'] : [])])];
  const warnings = [...(found.ytdlp.status === 'available' && ejs !== 'available' ? [ejsWarning] : []), ...(found.ytdlp.impersonate === 'missing' ? [impersonateWarning] : []),
    ...(found.node.newerLts ? [`Вышла новая линия Node.js ${found.node.newerLts} (LTS). Скилл работает и на нынешней; перейти на новую можно вручную с https://nodejs.org.`] : [])];
  return { platform, arch, tools: found, youtube, ...(winget ? { winget } : {}), ...(brew ? { brew } : {}), ready: Object.values(found).every(item => item.status === 'available') && youtube.status === 'available', updates, refresh, warnings };
}
const toolsFrom = inspection => Object.fromEntries(Object.entries(inspection.tools).map(([name, item]) => [name, item.path]));
const preserved = (name,relative) => /^(?:\.env(?:\..*)?|\.git|config\.json|settings\.json|credentials(?:\.json)?|secrets?|keys?|cookies(?:\..*)?)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || !relative && /^(?:config|settings|work|output|outputs|results|cache)$/i.test(name);
async function exists(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
// Windows: where.exe печатает пути в кодировке консоли, и кириллица в имени профиля пользователя теряется — ищем по PATH сами.
async function onPath(command, env) {
  const value = name => env[Object.keys(env).find(key => key.toUpperCase() === name)];
  const names = path.extname(command) ? [command] : String(value('PATHEXT') || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map(ext => command + ext.toLowerCase());
  for (const dir of String(value('PATH') || '').split(';').filter(Boolean)) for (const name of names) { const file = path.join(dir, name); if (await exists(file).catch(() => null)) return file; }
  return null;
}
async function noLinks(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await exists(current);
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw fail('INSTALL_LINK', 'Установка через ссылку, junction или hardlink запрещена.');
    if (stat && current !== absolute && !stat.isDirectory()) throw fail('INSTALL_PATH', 'Родительский путь не является папкой.');
  }
}
async function packageEntries(root, relative = '') {
  const entries = [];
  for (const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
    if (preserved(entry.name,relative)) continue;
    const rel = path.join(relative,entry.name), stat = await lstat(path.join(root,rel));
    if (stat.isSymbolicLink()) throw fail('PACKAGE_LINK','Ссылки в устанавливаемом пакете запрещены.');
    if (stat.isDirectory()) entries.push(...await packageEntries(root,rel));
    else if (stat.isFile()) entries.push(rel);
    else throw fail('PACKAGE_FILE','Пакет содержит неподдерживаемый тип файла.');
  }
  return entries;
}
// inPlace: скилл уже лежит там, где его ищет клиент (плагин Claude Code, npx skills add, установщик Codex), — копирование пропускается.
export async function installPackage({ agent, scope, projectRoot, inPlace = false, allowInstall = false, update = false, dryRun = false, tools, runProcess: run = runProcess, packageRoot = packageDirectory, home = os.homedir(), inspection, onProgress, ...options } = {}) {
  if (!inPlace) {
    if (!['codex','claude','both'].includes(agent)) throw fail('INSTALL_AGENT','agent: codex, claude или both.');
    if (!['user','project'].includes(scope)) throw fail('INSTALL_SCOPE','scope: user или project.');
    if (scope === 'project' && !projectRoot) throw fail('INSTALL_PROJECT','Укажите projectRoot для установки в проект.');
  }
  const targets = inPlace ? [] : (agent === 'both' ? ['codex','claude'] : [agent]).map(name => path.join(path.resolve(scope === 'user' ? home : projectRoot),name === 'codex' ? '.agents' : '.claude','skills','transcribe-media'));
  packageRoot = path.resolve(packageRoot);
  for (const target of targets) {
    if (target === packageRoot || !path.relative(packageRoot,target).startsWith('..') && !path.isAbsolute(path.relative(packageRoot,target))) throw fail('INSTALL_RECURSION','Папка назначения не может находиться внутри исходного пакета.');
    await noLinks(target);
  }
  // Скилл страницы настроек (/transcribe-settings) ставится рядом с основным: из пакета, а если основной скилл скачан один
  // (установщик Codex берёт одну папку), — из копии companion/ внутри него; SKILL.template.md при копировании становится SKILL.md.
  const sibling = path.join(path.dirname(packageRoot),'transcribe-settings'), bundled = path.join(packageRoot,'companion','transcribe-settings');
  const companionRoot = await exists(path.join(sibling,'SKILL.md')) ? sibling : await exists(path.join(bundled,'SKILL.template.md')) ? bundled : null;
  const companions = !companionRoot ? [] : inPlace ? (companionRoot === bundled ? [sibling] : []) : targets.map(target => path.join(path.dirname(target),'transcribe-settings'));
  const placed = relative => relative === 'SKILL.template.md' ? 'SKILL.md' : relative;
  for (const target of companions) await noLinks(target);
  const dependencies = inspection || await inspectDependencies({tools,runProcess:run,...options,onProgress});
  const settled = dependencies.ready && !dependencies.refresh?.length;
  const dependencyPlan = settled ? null : await repairDependencies({tools,runProcess:run,home,...options,inspection:dependencies,dryRun:true,onProgress});
  const plan = [...targets.map(target => ({action:update?'merge-package':'copy-package',source:packageRoot,target,preserve:['config','credentials','work','output','results','cookies']})),...companions.map(target => ({action:update?'merge-package':'copy-package',source:companionRoot,target,preserve:[]})),...(dependencyPlan?.plan || [])];
  const warnings = dependencyPlan?.warnings || dependencies.warnings || [];
  if (!allowInstall || dryRun) return {status:'planned',targets,dependencies,plan,warnings};
  if (!update && (await Promise.all(targets.map(exists))).some(Boolean)) return {status:'existing',targets,dependencies,plan,warnings:[...warnings,'Пакет уже существует. Для обновления укажите --update.']};
  const entries = inPlace ? [] : (await noLinks(packageRoot), await packageEntries(packageRoot));
  if (!inPlace && !entries.includes('SKILL.md')) throw fail('PACKAGE_INVALID','В пакете отсутствует SKILL.md.');
  const companionEntries = companions.length ? (await noLinks(companionRoot), await packageEntries(companionRoot)) : [];
  const copies = [...targets.map(target => [packageRoot,target,entries]),...companions.map(target => [companionRoot,target,companionEntries])];
  for (const [,target,files] of copies) for (const relative of files) await noLinks(path.join(target,placed(relative)));
  const repair = settled ? null : await repairDependencies({tools,runProcess:run,home,...options,inspection:dependencies,allowInstall:true,onProgress});
  if (repair?.status === 'manual-required') return {status:'manual-required',targets,dependencies,tools:repair.tools,plan,warnings:repair.warnings};
  let done=0;const totalFiles=copies.reduce((sum,[,,files])=>sum+files.length,0);
  for (const [source,target,files] of copies) {
    await mkdir(target,{recursive:true});
    for (const relative of files) {
      const destination = path.join(target,placed(relative));
      await mkdir(path.dirname(destination),{recursive:true});
      await noLinks(destination);
      await copyFile(path.join(source,relative),destination);
      await progress(onProgress,{tool:'package',operation:'copy',status:'running',done:++done,totalFiles});
    }
  }
  return {status:update?'updated':'installed',targets,dependencies:repair?.inspection || dependencies,tools:repair?.tools || toolsFrom(dependencies),plan,warnings:repair?.warnings || warnings};
}
// default — компонент EJS для YouTube, curl-cffi — запросы под видом браузера (TikTok и другие сайты с защитой).
const pipCommand = ['-m','pip','install','-U','yt-dlp[default,curl-cffi]'];
const fromTo = step => step.from && step.to ? ` с ${step.from} до ${step.to}` : '';
const appInstallerUrl = 'https://apps.microsoft.com/detail/9NBLGGH4NNS1';
// Человекочитаемый план для панели, терминала и чата; сам план остаётся машинным.
export function describePlan(plan = []) {
  return plan.map(step => {
    if (step.action === 'copy-package') return `Скопировать скилл в ${step.target}`;
    if (step.action === 'merge-package') return `Обновить скилл в ${step.target}; настройки и результаты сохраняются`;
    const title = toolTitles[step.tool] || step.tool;
    if (step.kind === 'download') return `Скачать ${title} с ${hostOf(step.url)}, сверить контрольную сумму SHA-256 и положить в личную папку программ${step.optional ? ' (нужно только для YouTube)' : ''}`;
    if (step.kind === 'winget' && step.verb === 'upgrade') return `Обновить ${title}${fromTo(step)} через winget (пакет ${step.id})${step.tool === 'node' ? '; Windows попросит разрешение на изменения — нажмите «Да». Работающие программы не закрываются; если Node.js занят, новая версия заработает после перезагрузки' : ''}`;
    if (step.kind === 'self-update') return `Обновить yt-dlp${fromTo(step)} его встроенной командой yt-dlp -U`;
    if (step.kind === 'winget') return `Установить ${title} через winget (пакет ${step.id})${step.tool === 'node' ? '; Windows попросит разрешение на изменения — нажмите «Да»' : ''}${step.tool === 'ytdlp' ? '; вместе с ним winget поставит Deno и FFmpeg, которые рекомендует yt-dlp' : ''}${step.tool === 'ffmpeg' ? '; шаг пропускается, если FFmpeg уже появится вместе с yt-dlp' : ''}${step.optional ? ' (нужно только для YouTube)' : ''}`;
    if (step.kind === 'brew') return `${step.args[0] === 'upgrade' ? 'Обновить' : 'Установить'} ${title}${fromTo(step)} через Homebrew (brew ${step.args.join(' ')})${step.tool === 'ytdlp' ? '; Homebrew поставит его вместе с компонентом EJS и Deno' : ''}${step.optional ? ' (нужно только для YouTube)' : ''}`;
    if (step.kind === 'pip') return `Обновить yt-dlp${fromTo(step)} так, как рекомендуют его разработчики для установки через pip: python ${pipCommand.join(' ')} — вместе с компонентом EJS (для YouTube) и модулем curl_cffi (для TikTok и других сайтов с защитой)`;
    if (step.kind === 'manual' && !step.tool && !step.command) return String(step.message || '');
    if (step.kind === 'manual') return `${title ? title + ': ' : ''}установите вручную${step.command ? ` (${[step.command,...(step.args||[])].join(' ')})` : ''}. ${step.message || ''}`.trim();
    return String(step.message || step.action || step.kind);
  });
}
function userToolRoot({home = os.homedir(),platform = process.platform,env = process.env} = {}) {
  return path.join(platform === 'win32' ? env.LOCALAPPDATA || path.join(home,'AppData','Local') : platform === 'darwin' ? path.join(home,'Library','Application Support') : env.XDG_DATA_HOME || path.join(home,'.local','share'),'transcribe-media','tools');
}
// Windows: программы ставятся способом, который указывают их разработчики, — через winget (официальный MSI Node.js,
// официальный yt-dlp.exe, сборка FFmpeg от gyan.dev), а yt-dlp из pip обновляется через pip. В личную папку ничего не скачивается.
const outdatedTool = (inspection,name) => (inspection.updates || []).find(item => item.tool === name);
const versionStep = update => update ? {from:update.current,to:update.latest} : {};
// yt-dlp обновляется, если нет EJS или curl_cffi или вышла новая версия; сбой обновления не останавливает установку.
const ytdlpStale = inspection => inspection.youtube.ejs !== 'available' || inspection.tools.ytdlp.impersonate === 'missing' || !!outdatedTool(inspection,'ytdlp');
function windowsPlan(inspection) {
  const {tools,youtube,winget} = inspection, absent = name => tools[name].status !== 'available';
  const wanted = [...(absent('node')?['node']:[]),...(absent('ytdlp')?['ytdlp']:[]),...(absent('ffmpeg')||absent('ffprobe')?['ffmpeg']:[])];
  const hasWinget = winget?.status === 'available', plan = [];
  if (wanted.length && !hasWinget) return [{kind:'manual',automatic:false,url:appInstallerUrl,message:`Не хватает: ${wanted.map(name=>toolTitles[name]).join(', ')}. На компьютере нет winget — установите «Установщик приложений» из Microsoft Store (${appInstallerUrl}) и запустите установку снова.`}];
  for (const tool of wanted) plan.push({kind:'winget',tool,id:wingetPackages[tool],...(tool === 'ffmpeg' && wanted.includes('ytdlp') ? {skipIfPresent:true} : {})});
  if (!absent('ytdlp') && ytdlpStale(inspection)) {
    const version = versionStep(outdatedTool(inspection,'ytdlp'));
    if (tools.ytdlp.variant === 'pip') plan.push({kind:'pip',tool:'ytdlp',optional:true,args:pipCommand,...version});
    else if (hasWinget && /[\\/]WinGet[\\/]/i.test(tools.ytdlp.location || tools.ytdlp.path)) plan.push({kind:'winget',verb:'upgrade',tool:'ytdlp',id:wingetPackages.ytdlp,optional:true,...version});
    else if (youtube.ejs !== 'available' && hasWinget) plan.push({kind:'winget',tool:'ytdlp',id:wingetPackages.ytdlp,optional:true});
    else plan.push({kind:'self-update',tool:'ytdlp',optional:true,...version});
  }
  const ffmpeg = !absent('ffmpeg') && outdatedTool(inspection,'ffmpeg');
  if (ffmpeg && hasWinget) plan.push({kind:'winget',verb:'upgrade',tool:'ffmpeg',id:/Gyan\.FFmpeg_/i.test(tools.ffmpeg.location || tools.ffmpeg.path) ? 'Gyan.FFmpeg' : wingetPackages.ffmpeg,optional:true,...versionStep(ffmpeg)});
  // Node.js — последним: его установщик заменяет node.exe, на котором работает этот мастер (и, возможно, сам ассистент).
  // MSIRESTARTMANAGERCONTROL=Disable не даёт установщику Windows закрывать работающие программы; занятый файл заменится после перезагрузки.
  const node = !absent('node') && outdatedTool(inspection,'node');
  if (node && hasWinget && tools.node.wingetId) plan.push({kind:'winget',verb:'upgrade',tool:'node',id:tools.node.wingetId,custom:'MSIRESTARTMANAGERCONTROL=Disable',optional:true,...versionStep(node)});
  return plan;
}
// macOS: недостающее ставится через Homebrew; yt-dlp из Homebrew уже содержит EJS. В личную папку ничего не скачивается.
const brewOwned = location => /^(?:\/opt\/homebrew|\/usr\/local)\/(?:bin|Cellar)\//.test(String(location || ''));
function macPlan(inspection) {
  const {tools,youtube,brew} = inspection, absent = name => tools[name].status !== 'available';
  const wanted = [...(absent('node')?['node']:[]),...(absent('ytdlp')?['ytdlp']:[]),...(absent('ffmpeg')||absent('ffprobe')?['ffmpeg']:[])];
  const ejsOnly = !absent('ytdlp') && youtube.ejs !== 'available', hasBrew = brew?.status === 'available', plan = [];
  if (wanted.length && !hasBrew) return [{kind:'manual',automatic:false,url:'https://brew.sh',message:`Не хватает: ${wanted.map(name=>toolTitles[name]).join(', ')}. На компьютере нет Homebrew — установите его по инструкции с https://brew.sh (нужен пароль администратора) и запустите установку снова.`}];
  for (const tool of wanted) plan.push({kind:'brew',tool,formula:brewFormulas[tool],args:['install',brewFormulas[tool]]});
  if (!absent('ytdlp') && ytdlpStale(inspection)) {
    const version = versionStep(outdatedTool(inspection,'ytdlp'));
    if (hasBrew && brewOwned(tools.ytdlp.location)) plan.push({kind:'brew',tool:'ytdlp',formula:'yt-dlp',args:['upgrade','yt-dlp'],optional:true,...version});
    else if (tools.ytdlp.variant === 'pip') plan.push({kind:'pip',tool:'ytdlp',optional:true,args:pipCommand,...version});
    else if (ejsOnly && hasBrew) plan.push({kind:'brew',tool:'ytdlp',formula:'yt-dlp',args:['install','yt-dlp'],optional:true});
    else plan.push({kind:'self-update',tool:'ytdlp',optional:true,...version});
  }
  for (const tool of ['ffmpeg','node']) {
    const update = !absent(tool) && outdatedTool(inspection,tool);
    if (update && hasBrew && brewOwned(tools[tool].location)) plan.push({kind:'brew',tool,formula:brewFormulas[tool],args:['upgrade',brewFormulas[tool]],optional:true,...versionStep(update)});
  }
  return plan;
}
function downloadPlan(inspection,root) {
  const {platform,arch} = inspection, plan = [];
  if (platform === 'win32') return windowsPlan(inspection);
  if (platform === 'darwin') return macPlan(inspection);
  const supported = ['win32','darwin','linux'].includes(platform) && ['x64','arm64'].includes(arch);
  if (!supported) return [{kind:'manual',automatic:false,message:`ОС/архитектура ${platform}/${arch}: укажите существующие пути инструментов.`}];
  if (inspection.tools.node.status !== 'available') {
    const version = 'v22.23.3', file = `node-${version}-${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.xz'}`;
    plan.push({kind:'download',tool:'node',url:`https://nodejs.org/dist/${version}/${file}`,sha256:`https://nodejs.org/dist/${version}/SHASUMS256.txt`,asset:file,archive:true,target:path.join(root,'node'),source:'https://nodejs.org/en/download'});
  }
  if (inspection.tools.ffmpeg.status !== 'available' || inspection.tools.ffprobe.status !== 'available') {
    if (platform === 'win32' && arch === 'x64') {
      const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
      plan.push({kind:'download',tool:'ffmpeg',url,sha256:`${url}.sha256`,asset:'ffmpeg-release-essentials.zip',archive:true,target:path.join(root,'ffmpeg'),source:'https://ffmpeg.org/download.html'});
    } else if (platform === 'linux') {
      const asset = `ffmpeg-master-latest-${arch === 'arm64' ? 'linuxarm64' : 'linux64'}-gpl.tar.xz`,base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
      plan.push({kind:'download',tool:'ffmpeg',url:base+asset,sha256:base+'checksums.sha256',asset,archive:true,target:path.join(root,'ffmpeg'),source:'https://ffmpeg.org/download.html'});
    } else plan.push({kind:'manual',tool:'ffmpeg',automatic:false,requiresPrivileges:platform === 'win32'?'возможны права администратора':'запись в префикс Homebrew',command:platform === 'darwin'?'brew':'winget',args:platform === 'darwin'?['install','ffmpeg']:['install','--id','Gyan.FFmpeg','--exact'],message:'Запасной пакетный менеджер выбирается пользователем отдельно. Укажите пути ffmpeg/ffprobe после установки; автоматического fallback нет.'});
  }
  if (inspection.tools.ytdlp.status !== 'available' || ytdlpStale(inspection)) {
    const asset = platform === 'win32' ? arch === 'arm64' ? 'yt-dlp_arm64.exe':'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : arch === 'arm64' ? 'yt-dlp_linux_aarch64':'yt-dlp_linux';
    const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
    // Если yt-dlp уже работает и не хватает только EJS, сбой этой загрузки не останавливает установку.
    plan.push({kind:'download',tool:'ytdlp',url:base+asset,sha256:base+'SHA2-256SUMS',asset,archive:false,target:path.join(root,platform === 'win32'?'yt-dlp.exe':'yt-dlp'),bundledEjs:true,optional:inspection.tools.ytdlp.status === 'available',source:'https://github.com/yt-dlp/yt-dlp/wiki/EJS'});
  }
  return plan;
}
// Загрузка обрывается только при простое без новых данных: общий лимит не подходит для архива FFmpeg на медленной сети.
async function fetchBytes(url,fetchImpl,maxBytes = 350_000_000,onProgress,tool,operation='download',{idleMs = 60000,progressMs = 500} = {}) {
  const title = toolTitles[tool] || tool, host = hostOf(url), controller = new AbortController(); let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
  touch();
  try {
    const response = await fetchImpl(url,{signal:controller.signal});
    if (!response.ok) throw fail('DOWNLOAD_FAILED',`${title}: ${host} ответил ошибкой ${response.status}. Повторите установку позже.`);
    const contentLength=Number(response.headers?.get('content-length'));const total=contentLength>0?contentLength:undefined;
    const chunks = []; let size = 0, reported = 0;
    for await (const chunk of response.body) {
      touch(); size += chunk.length; if (size > maxBytes) throw fail('DOWNLOAD_SIZE',`${title}: размер загрузки с ${host} превысил ограничение.`); chunks.push(Buffer.from(chunk));
      if (Date.now() - reported >= progressMs) { reported = Date.now(); await progress(onProgress,{tool,operation,status:'running',loaded:size,...(total?{total}:{})}); }
    }
    await progress(onProgress,{tool,operation,status:'done',loaded:size,...(total?{total}:{})});
    return Buffer.concat(chunks);
  } catch (error) {
    if (error.installerSafe) throw error;
    if (controller.signal.aborted) throw fail('DOWNLOAD_STALLED',`${title}: загрузка с ${host} остановилась — ${Math.round(idleMs/1000)} секунд нет новых данных. Проверьте интернет и повторите установку.`);
    throw fail('DOWNLOAD_FAILED',`${title}: не удалось подключиться к ${host}. Проверьте интернет и повторите установку.`);
  } finally { clearTimeout(timer); }
}
function checksumFor(text,asset) {
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})(?:\s+\*?(.+))?$/i);
    if (match && (!match[2] || match[2] === asset || match[2] === `./${asset}`)) return match[1].toLowerCase();
  }
  throw fail('DOWNLOAD_CHECKSUM','В опубликованном списке отсутствует SHA-256 выбранного файла.');
}
async function extractArchive(archive,destination,run,platform,onlyNode = false) {
  await mkdir(destination,{recursive:true});
  if (platform === 'win32' && archive.endsWith('.zip')) {
    const q = value => "'"+value.replace(/'/g,"''")+"'";
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${q(archive)}); try { foreach($e in $z.Entries) { $n=$e.FullName.Replace('\\','/'); if($n.StartsWith('/') -or $n -match '(^|/)\.\.(/|$)' -or $n -match '^[A-Za-z]:' -or (($e.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive' } } } finally { $z.Dispose() }; Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(destination)} -Force`;
    const result = await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],processOptions);
    if (result.code !== 0) throw fail('ARCHIVE_EXTRACT','Не удалось безопасно распаковать ZIP.');
  } else {
    const names = await run('tar',['-tf',archive],processOptions);
    if (names.code !== 0 || names.stdout.split(/\r?\n/).some(name=>/^[-/\\]|^[A-Za-z]:|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(name))) throw fail('ARCHIVE_PATH','Архив содержит опасные пути.');
    const selected = onlyNode ? names.stdout.split(/\r?\n/).filter(name=>/^[^/]+\/bin\/node$/.test(name)) : [];
    if (onlyNode && selected.length !== 1) throw fail('ARCHIVE_BINARY','В архиве Node не найден один исполняемый файл.');
    const listing = await run('tar',['-tvf',archive,'--',...selected],processOptions);
    if (listing.code !== 0 || listing.stdout.split(/\r?\n/).filter(Boolean).some(line=>onlyNode?!line.startsWith('-'):/^[lh]/.test(line))) throw fail('ARCHIVE_LINK','Архив содержит ссылки или не читается.');
    const result = await run('tar',['-xf',archive,'-C',destination,'--',...selected],processOptions);
    if (result.code !== 0) throw fail('ARCHIVE_EXTRACT','Не удалось распаковать архив.');
  }
}
async function findExecutable(root,name,depth = Infinity) {
  for (const entry of await readdir(root,{withFileTypes:true})) {
    const file = path.join(root,entry.name),stat = await lstat(file);
    if (stat.isSymbolicLink()) throw fail('ARCHIVE_LINK','Распакованный архив содержит ссылку.');
    if (stat.isFile() && entry.name === name) return file;
    if (stat.isDirectory() && depth > 0) {const match = await findExecutable(file,name,depth - 1);if(match)return match;}
  }
  return null;
}
const hexCode = code => Number.isInteger(code) ? '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8,'0') : String(code);
// Пока идёт внешний установщик, раз в несколько секунд сообщаем, сколько он уже работает: процента он не даёт.
async function withHeartbeat(onProgress,tool,operation,task) {
  const started = Date.now(), tick = status => progress(onProgress,{tool,operation,status,elapsed:Math.round((Date.now()-started)/1000)});
  await tick('running'); const timer = setInterval(() => tick('running').catch(() => {}), 5000);
  try { return await task(); } finally { clearInterval(timer); await tick('done'); }
}
async function applyWinget(step,{run,platform,env,inspection,resolved,onProgress}) {
  const title = toolTitles[step.tool], names = step.tool === 'ffmpeg' ? ['ffmpeg','ffprobe'] : [step.tool];
  const locateAll = async () => { const found = {}; for (const name of names) found[name] = await locateTool(name, resolved[name], {runProcess:run,platform,env}); return found; };
  if (step.skipIfPresent) { const found = await locateAll(); if (names.every(name => found[name].status === 'available')) { for (const name of names) resolved[name] = found[name].path; await progress(onProgress,{tool:step.tool,operation:'winget',status:'skipped',message:`${title} уже появился вместе с yt-dlp — отдельная установка не нужна.`}); return; } }
  const args = [step.verb || 'install','--id',step.id,'--exact','--source','winget','--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity',...(step.custom ? ['--custom',step.custom] : [])];
  let result;
  try { result = await withHeartbeat(onProgress,step.tool,step.verb === 'upgrade' ? 'winget-upgrade' : 'winget',() => run(inspection.winget.path,args,{...processOptions,timeoutMs:30*60*1000,tailOnly:true})); }
  catch { throw fail('WINGET_START',`${title}: не удалось запустить winget.`); }
  const found = await locateAll();
  for (const name of names) if (found[name].status === 'available') resolved[name] = found[name].path;
  const missing = names.filter(name => found[name].status !== 'available');
  if (missing.length) throw fail('WINGET_FAILED',`${title}: winget завершился с кодом ${hexCode(result.code)}, программа не найдена.${step.tool === 'node' ? ' Если Windows спрашивала разрешение на изменения, повторите установку и нажмите «Да».' : ' Повторите установку; если ошибка повторится, выполните в терминале: winget install --id ' + step.id}`);
}
async function applyBrew(step,{run,platform,env,inspection,resolved,onProgress}) {
  const title = toolTitles[step.tool], names = step.tool === 'ffmpeg' ? ['ffmpeg','ffprobe'] : [step.tool];
  let result;
  // NONINTERACTIVE=1 — штатный способ Homebrew работать без вопросов в терминале.
  try { result = await withHeartbeat(onProgress,step.tool,'brew',() => run(inspection.brew.path,step.args,{...processOptions,env:{...env,NONINTERACTIVE:'1'},timeoutMs:30*60*1000,tailOnly:true})); }
  catch { throw fail('BREW_START',`${title}: не удалось запустить Homebrew.`); }
  const missing = [];
  for (const name of names) { const found = await locateTool(name, resolved[name], {runProcess:run,platform,env}); if (found.status === 'available') resolved[name] = found.path; else missing.push(name); }
  if (missing.length) throw fail('BREW_FAILED',`${title}: Homebrew завершился с кодом ${result.code}, программа не найдена. Выполните в Терминале: brew ${step.args.join(' ')} — и запустите установку снова.`);
}
async function applyPip(step,{run,platform,env,inspection,onProgress}) {
  const current = inspection.tools.ytdlp.path, manual = `Обновите вручную: python ${pipCommand.join(' ')}`;
  if (platform !== 'win32') {
    // На macOS/Linux нужный Python указан в первой строке скрипта yt-dlp («#!/…/python3»).
    const script = inspection.tools.ytdlp.location || (path.isAbsolute(current) ? current : null);
    const shebang = script ? (await readFile(script,'utf8').catch(() => '')).split('\n')[0] : '';
    const python = shebang.startsWith('#!') ? shebang.slice(2).trim().split(/\s+/).filter(part => !/(?:^|\/)env$/.test(part))[0] : null;
    if (!python) throw fail('PIP_PYTHON',`не найден Python, в который установлен yt-dlp. ${manual}`);
    // yt-dlp, поставленный с --user, лежит в ~/Library/Python/…: обновлять его нужно тоже с --user.
    const args = [...step.args,...(/\/Library\/Python\/|\/\.local\//.test(script) ? ['--user'] : [])];
    const result = await withHeartbeat(onProgress,'ytdlp','pip',() => run(python,args,{...processOptions,timeoutMs:10*60*1000,tailOnly:true}));
    if (result.code !== 0) throw fail('PIP_FAILED',`pip завершился с кодом ${result.code}. ${manual}`);
    return;
  }
  // Windows: обновляем тот же Python, которому принадлежит найденный yt-dlp: …\PythonXY\Scripts\yt-dlp.exe → …\PythonXY\python.exe.
  let script = path.isAbsolute(current) ? current : null;
  if (!script) { const found = inspection.tools.ytdlp.location || await onPath(current,env); script = found && /[\\/]Scripts[\\/]yt-dlp(?:\.exe)?$/i.test(found) ? found : null; }
  const python = script && /[\\/]Scripts[\\/]/i.test(script) ? path.join(path.dirname(path.dirname(script)),'python.exe') : null;
  if (!python || !await exists(python).catch(() => null)) throw fail('PIP_PYTHON',`не найден Python, в который установлен yt-dlp. ${manual}`);
  const result = await withHeartbeat(onProgress,'ytdlp','pip',() => run(python,step.args,{...processOptions,timeoutMs:10*60*1000,tailOnly:true}));
  if (result.code !== 0) throw fail('PIP_FAILED',`pip завершился с кодом ${result.code}. ${manual}`);
}
// Отдельный файл yt-dlp (не pip и не Homebrew) обновляет себя сам с GitHub и сверяет контрольную сумму.
async function applySelfUpdate(step,{run,resolved,onProgress}) {
  const result = await withHeartbeat(onProgress,'ytdlp','self-update',() => run(resolved.ytdlp,['-U'],{...processOptions,timeoutMs:10*60*1000,tailOnly:true}));
  if (result.code !== 0) throw fail('YTDLP_UPDATE_FAILED',`yt-dlp не смог обновиться сам (код ${result.code}). Скачайте новую версию с https://github.com/yt-dlp/yt-dlp/releases/latest.`);
}
async function applyStep(step,options) {
  if (step.kind === 'self-update') return applySelfUpdate(step,options);
  if (step.kind === 'winget') return applyWinget(step,options);
  if (step.kind === 'brew') return applyBrew(step,options);
  if (step.kind === 'pip') return applyPip(step,options);
  const {root,fetchImpl,run,platform,inspection,resolved,onProgress} = options;
  const title = toolTitles[step.tool] || step.tool;
  await mkdir(root,{recursive:true});
  const bytes = await fetchBytes(step.url,fetchImpl,350_000_000,onProgress,step.tool);
  const sums = await fetchBytes(step.sha256,fetchImpl,2_000_000,onProgress,step.tool,'checksum-download');
  await progress(onProgress,{tool:step.tool,operation:'verify',status:'running'});
  if (createHash('sha256').update(bytes).digest('hex') !== checksumFor(sums.toString('utf8'),step.asset)) throw fail('DOWNLOAD_CHECKSUM',`${title}: контрольная сумма SHA-256 скачанного файла не совпала с опубликованной. Файл не установлен; повторите установку.`);
  await progress(onProgress,{tool:step.tool,operation:'verify',status:'done'});
  if (step.archive) {
    const download = path.join(root,`${randomUUID()}-${step.asset}`),extract = path.join(root,`${step.tool}-${randomUUID()}`);
    try {
      await writeFile(download,bytes,{flag:'wx'});
      await progress(onProgress,{tool:step.tool,operation:'extract',status:'running'});
      await extractArchive(download,extract,run,platform,step.tool==='node');
      await progress(onProgress,{tool:step.tool,operation:'extract',status:'done'});
    } finally { await rm(download,{force:true}); }
    for (const name of step.tool === 'ffmpeg'?['ffmpeg','ffprobe']:['node']) {
      if (step.tool === 'ffmpeg' && inspection.tools[name].status === 'available') continue;
      const executable = await findExecutable(extract,name+(platform==='win32'?'.exe':''));
      if (!executable) throw fail('ARCHIVE_BINARY',`${title}: в архиве нет файла ${name}.`);
      resolved[name] = executable;
    }
  } else { await noLinks(step.target); await writeFile(step.target,bytes,{mode:0o755}); if(platform!=='win32') await chmod(step.target,0o755);resolved[step.tool]=step.target; }
}
export async function repairDependencies({allowInstall = false,dryRun = false,tools,runProcess:run = runProcess,fetchImpl = fetch,installRoot,home,platform = process.platform,arch = process.arch,env = process.env,inspection:previousInspection,onProgress,checkUpdates = false} = {}) {
  const root = path.resolve(installRoot || userToolRoot({home,platform,env}));
  await noLinks(root);
  const inspection = previousInspection || await inspectDependencies({tools,runProcess:run,platform,arch,env,onProgress,checkUpdates,fetchImpl});
  const plan = downloadPlan(inspection,root),resolved = toolsFrom(inspection);
  const note = platform !== 'linux' ? 'Найденные и установленные программы записываются в настройки скилла полными путями; скилл работает сразу, даже если открытые окна ещё не видят новые программы.' : 'Программы устанавливаются в личную папку пользователя; системная переменная PATH не меняется.';
  // Устаревшую программу, которую мастер не умеет обновить (нет winget/Homebrew, чужой способ установки), пользователь обновляет сам.
  const manualUpdates = (inspection.updates || []).filter(item => !plan.some(step => step.tool === item.tool)).map(item => `${toolTitles[item.tool]} ${item.current} устарел (последняя версия ${item.latest}): обновите его тем способом, которым устанавливали.`);
  const warnings = [...inspection.warnings,...manualUpdates,note];
  if (!plan.length) return {status:'ready',inspection,tools:resolved,plan,warnings:[...inspection.warnings,...manualUpdates]};
  if (!allowInstall || dryRun) return {status:'planned',inspection,tools:resolved,plan,warnings};
  if (plan.some(step=>step.kind==='manual')) return {status:'manual-required',inspection,tools:resolved,plan,warnings};
  const skipped = [];
  for (const step of plan) {
    try { await applyStep(step,{root,fetchImpl,run,platform,env,inspection,resolved,onProgress}); }
    catch (error) { if (!step.optional) throw error; const title = toolTitles[step.tool] || step.tool; skipped.push(`${title} не обновлён: ${error.installerSafe ? error.message : 'установка не удалась.'} Оставлен прежний ${title}.`); }
  }
  const verified = await inspectDependencies({tools:resolved,runProcess:run,platform,arch,env,onProgress});
  const broken = Object.entries(verified.tools).filter(([,item]) => item.status !== 'available').map(([name]) => toolTitles[name] || name);
  if (broken.length) throw fail('INSTALL_VERIFICATION',`После установки не запускается: ${broken.join(', ')}. Скилл не скопирован; повторите установку или укажите путь к программе вручную.`);
  // Путь к Node.js запоминается после установки; обновление (шаг с версией to) путь не меняет.
  if (plan.some(step=>step.tool==='node' && !step.to)) { const locator = path.join(root,'node-path.txt'); await noLinks(locator); await writeFile(locator,resolved.node+'\n',{mode:0o600}); }
  // Обновление могло завершиться без ошибки, но не примениться (занятый node.exe, «нет обновлений» у пакетного менеджера).
  // Пакетный менеджер может отставать от сайта разработчика на выпуск, поэтому сравнение — с прежней версией, а не с последней.
  const unchanged = plan.filter(step => step.from && !isNewer(step.tool === 'ffmpeg' ? verified.tools.ffmpeg.release : verified.tools[step.tool]?.version,step.from)).map(step => `${toolTitles[step.tool]} пока остался прежней версии${step.tool === 'node' ? ': если Node.js был занят, новая версия появится после перезагрузки компьютера.' : '; повторите обновление позже.'}`);
  return {status:'repaired',inspection:verified,tools:resolved,plan,warnings:[...skipped,...unchanged,...manualUpdates,...verified.warnings,note]};
}
