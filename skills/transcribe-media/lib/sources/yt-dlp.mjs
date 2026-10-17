import path from 'node:path';
import { checkedProcess, runProcess } from './process.mjs';
import { sourceError } from './errors.mjs';

// yt-dlp README and EJS wiki: explicit Node runtime; never load global config.
// Retries concern source reads only and remain bounded. No remote EJS downloads.
export function ytdlpArgs(config = {}, cwd = process.cwd()) {
  const access = config.sourceAccess || {};
  if ((access.cookiesFile || access.cookiesBrowser) && access.allowCookies !== true) throw sourceError('COOKIES_NOT_ALLOWED', 'Для cookies требуется явное разрешение allowCookies.');
  const args = ['--ignore-config', '--no-playlist', '--no-progress', '--no-js-runtimes', '--js-runtimes', `node:${config.tools?.node || 'node'}`, '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '2', '--socket-timeout', '30'];
  // Without it yt-dlp on Windows prints paths and JSON in the console code page, and a Cyrillic path breaks on UTF-8 decoding.
  args.push('--encoding', 'utf-8');
  // direct: bypass HTTP(S)_PROXY and the Windows system proxy; YouTube answers a datacenter proxy with a bot check.
  if (config.sourceProxy === 'direct') args.push('--proxy', '');
  if (access.allowCookies === true && access.cookiesFile) args.push('--cookies', path.resolve(cwd, access.cookiesFile));
  if (access.allowCookies === true && access.cookiesBrowser) args.push('--cookies-from-browser', access.cookiesBrowser);
  return args;
}
// With PYTHONUTF8=1 curl_cffi hands libcurl the CA bundle path in UTF-8, while libcurl on Windows expects the ANSI code page:
// a Cyrillic profile path then fails with curl error 77 (TikTok, Instagram). Output is UTF-8 anyway through --encoding.
export function ytdlpEnv(env = process.env) { return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PYTHONUTF8')); }
// After a failure the installed yt-dlp is compared with the latest release on PyPI; offline, only a version
// older than yt-dlp's own warning threshold counts as outdated (a fixed age misfires: releases may pause for months).
const latestYtdlp = 'https://pypi.org/pypi/yt-dlp/json';
export const ytdlpStaleDays = 90;
const versionNumbers = value => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
const newer = (latest, current) => { const a = versionNumbers(latest), b = versionNumbers(current); for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return false; };
async function outdatedVersion(executable, options) {
  try {
    const result = await (options.runProcess || runProcess)(executable, ['--version'], { shell: false, windowsHide: true, timeoutMs: 15000, env: ytdlpEnv(options.env) });
    const [current, year, month, day] = String(result?.stdout || '').match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/) || [];
    if (!year) return null;
    let latest = null;
    try { const response = await (options.fetchImpl || fetch)(latestYtdlp, { signal: AbortSignal.timeout(10000) }); if (response.ok) latest = String((await response.json())?.info?.version || ''); } catch { /* offline: fall back to the age */ }
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const behind = /^\d{4}\.\d{1,2}\.\d{1,2}/.test(latest || '') ? newer(latest, current) : now - Date.UTC(+year, +month - 1, +day) > ytdlpStaleDays * 86400000;
    return behind ? { released: `${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year}`, ...(latest ? { latest } : {}) } : null;
  } catch { return null; }
}
export async function callYtdlp(args, options = {}) {
  const executable = options.config?.tools?.ytdlp || 'yt-dlp', workRoot = options.config?.workRoot;
  try { return await checkedProcess(executable, [...ytdlpArgs(options.config, options.accessCwd || options.cwd), ...args], { ...options, env: ytdlpEnv(options.env), ...(workRoot ? { diagnosticLog: path.join(workRoot, 'logs', 'source-error.log') } : {}) }); }
  catch (error) {
    const outdated = error.toolFailed && await outdatedVersion(executable, options);
    if (outdated) { error.toolOutdated = { tool: 'yt-dlp', ...outdated }; error.message += ` yt-dlp устарел (версия от ${outdated.released}${outdated.latest ? `, уже вышла ${outdated.latest}` : ''}): сайты часто меняются, обновление может помочь.`; }
    throw error;
  }
}
const choiceTitle = (entry, item) => String(entry.title || entry.id || `Видео ${item}`).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
export async function inspectMetadata(url, options = {}) {
  const item = options.item;
  const result = await callYtdlp(['--skip-download', '--dump-single-json', ...(item ? ['--playlist-items', String(item)] : []), '--', url], options);
  let metadata; try { metadata = JSON.parse(result.stdout); } catch { throw sourceError('SOURCE_METADATA', 'Источник вернул некорректные метаданные.'); }
  const entries = Array.isArray(metadata?.entries) ? metadata.entries.filter(entry => entry && typeof entry === 'object') : null;
  // A page with one video is still a playlist for yt-dlp; with several, the user picks one (--item).
  if (entries && (entries.length === 1 || item)) {
    if (entries.length !== 1) throw sourceError('SOURCE_ITEM', 'На странице нет видео с таким номером.');
    metadata = { ...entries[0], playlistItem: item || entries[0].playlist_index || 1 };
  } else if (entries?.length > 1) {
    const choices = entries.slice(0, 20).map((entry, index) => { const number = entry.playlist_index || index + 1; return { item: number, title: choiceTitle(entry, number), ...(Number.isFinite(entry.duration) && entry.duration > 0 ? { durationSeconds: Math.round(entry.duration) } : {}) }; });
    throw Object.assign(sourceError('SOURCE_MULTIPLE', `На странице несколько видео (${entries.length}). Выберите одно и повторите с флагом --item НОМЕР.`), { choices });
  }
  if (!metadata || !metadata.id || metadata.entries || ['playlist', 'multi_video'].includes(metadata._type)) throw sourceError('SOURCE_MULTIPLE', 'Укажите ссылку на одно аудио или видео.');
  return metadata;
}
export function metadataSource(type, input, metadata) {
  const extractor = String(metadata.extractor_key || metadata.extractor || type).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const id = String(metadata.id);
  if (!/^[\w-]+$/.test(id)) throw sourceError('SOURCE_METADATA', 'Некорректная идентичность источника.');
  const family = ['youtube', 'tiktok', 'instagram'].find(name => extractor.includes(name)) || extractor;
  return { type, input, identity: `${family}:${id}`, title: String(metadata.title || id), ...(metadata.playlistItem ? { playlistItem: metadata.playlistItem } : {}), ...(metadata.webpage_url ? { canonicalUrl: metadata.webpage_url } : {}), ...(Number.isFinite(metadata.duration) && metadata.duration > 0 ? { durationSeconds: metadata.duration } : {}), metadata, subtitleTracks: { native: metadata.subtitles || {}, automatic: metadata.automatic_captions || {} } };
}
export function audioFormat(source) {
  const formats = source.metadata?.formats || [];
  const speechAudio = formats.filter(format => format.vcodec === 'none' && format.acodec !== 'none' && !/music|soundtrack/i.test(format.format_note || '') && (source.type !== 'tiktok' || /original audio|original sound/i.test(format.format_note || '')));
  if (speechAudio.length) return String(speechAudio.at(-1).format_id);
  // TikTok's format_id=audio can originate in music.playUrl, not video speech.
  const videos = formats.filter(format => format.vcodec !== 'none' && format.acodec !== 'none' && !/music|soundtrack/i.test(format.format_note || '')).sort((a, b) => (a.height || 0) - (b.height || 0) || (a.tbr || 0) - (b.tbr || 0));
  if (videos.length) return String(videos[0].format_id);
  if (source.type === 'tiktok') throw sourceError('SOURCE_NO_ORIGINAL_AUDIO', 'Источник не предоставил видео с оригинальным звуком. Музыкальная дорожка не подходит.');
  return 'bestaudio/best';
}
