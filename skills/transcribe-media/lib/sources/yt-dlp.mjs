import path from 'node:path';
import { checkedProcess } from './process.mjs';
import { sourceError } from './errors.mjs';

// yt-dlp README and EJS wiki: explicit Node runtime; never load global config.
// Retries concern source reads only and remain bounded. No remote EJS downloads.
export function ytdlpArgs(config = {}, cwd = process.cwd()) {
  const access = config.sourceAccess || {};
  if ((access.cookiesFile || access.cookiesBrowser) && access.allowCookies !== true) throw sourceError('COOKIES_NOT_ALLOWED', 'Для cookies требуется явное разрешение allowCookies.');
  const args = ['--ignore-config', '--no-playlist', '--no-progress', '--no-js-runtimes', '--js-runtimes', `node:${config.tools?.node || 'node'}`, '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '2', '--socket-timeout', '30'];
  // direct: bypass HTTP(S)_PROXY and the Windows system proxy; YouTube answers a datacenter proxy with a bot check.
  if (config.sourceProxy === 'direct') args.push('--proxy', '');
  if (access.allowCookies === true && access.cookiesFile) args.push('--cookies', path.resolve(cwd, access.cookiesFile));
  if (access.allowCookies === true && access.cookiesBrowser) args.push('--cookies-from-browser', access.cookiesBrowser);
  return args;
}
export async function callYtdlp(args, options = {}) {
  return checkedProcess(options.config?.tools?.ytdlp || 'yt-dlp', [...ytdlpArgs(options.config, options.accessCwd || options.cwd), ...args], options);
}
export async function inspectMetadata(url, options) {
  const result = await callYtdlp(['--skip-download', '--dump-single-json', '--', url], options);
  let metadata; try { metadata = JSON.parse(result.stdout); } catch { throw sourceError('SOURCE_METADATA', 'Источник вернул некорректные метаданные.'); }
  if (!metadata || !metadata.id || metadata.entries || ['playlist', 'multi_video'].includes(metadata._type)) throw sourceError('SOURCE_MULTIPLE', 'Укажите ссылку на одно аудио или видео.');
  return metadata;
}
export function metadataSource(type, input, metadata) {
  const extractor = String(metadata.extractor_key || metadata.extractor || type).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const id = String(metadata.id);
  if (!/^[\w-]+$/.test(id)) throw sourceError('SOURCE_METADATA', 'Некорректная идентичность источника.');
  const family = ['youtube', 'tiktok', 'instagram'].find(name => extractor.includes(name)) || extractor;
  return { type, input, identity: `${family}:${id}`, title: String(metadata.title || id), ...(metadata.webpage_url ? { canonicalUrl: metadata.webpage_url } : {}), ...(Number.isFinite(metadata.duration) && metadata.duration > 0 ? { durationSeconds: metadata.duration } : {}), metadata, subtitleTracks: { native: metadata.subtitles || {}, automatic: metadata.automatic_captions || {} } };
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
