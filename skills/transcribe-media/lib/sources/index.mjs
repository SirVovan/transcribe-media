import path from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint } from './fingerprint.mjs';
import { sourceError } from './errors.mjs';
import { inspectTikTok } from './tiktok.mjs';
import { inspectInstagram } from './instagram.mjs';
import { inspectYouTube } from './youtube.mjs';
import { inspectMetadata, metadataSource } from './yt-dlp.mjs';

export async function inspectSource(input, options = {}) {
  const { cwd = process.cwd() } = options;
  if (typeof input !== 'string' || !input.trim()) throw sourceError('SOURCE_INPUT', 'Укажите файл или URL источника.');
  if (/^https?:\/\//i.test(input)) {
    let url; try { url = new URL(input); } catch { throw sourceError('SOURCE_INPUT', 'Некорректный URL источника.'); }
    if (url.username || url.password) throw sourceError('SOURCE_INPUT', 'URL с учётными данными не поддерживается.');
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) return inspectYouTube(input, options);
    if (/(^|\.)tiktok\.com$/.test(host)) return inspectTikTok(input, options);
    if (/(^|\.)instagram\.com$/.test(host)) return inspectInstagram(input, options);
    if (/\.(?:mp3|mp4|m4a|wav|flac|ogg|opus|webm|mov|aac|mkv)(?:$)/i.test(url.pathname)) return { type: 'direct', input, identity: `urlsha256:${createHash('sha256').update(input).digest('hex')}`, title: path.basename(url.pathname) || 'media' };
    return metadataSource('remote', input, await inspectMetadata(input, options));
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(input)) throw sourceError('SOURCE_INPUT', 'Поддерживаются только HTTP/HTTPS URL и локальные файлы.');
  const localPath = path.resolve(cwd, input); let value;
  try { value = await fingerprint(localPath); } catch (error) { if (error.code === 'ENOENT') throw sourceError('SOURCE_NOT_FOUND', 'Локальный источник не найден.'); throw error; }
  return { type: 'local', input: localPath, localPath, identity: `sha256:${value.sha256}`, title: path.basename(localPath, path.extname(localPath)), fingerprint: value };
}
export async function verifySource(source) {
  if (!['local', 'direct'].includes(source.type)) return;
  const expected = source.type === 'direct' ? source.downloadFingerprint : source.fingerprint;
  let current; try { current = await fingerprint(source.localPath); } catch { throw sourceError('SOURCE_CHANGED', 'Локальный источник недоступен или изменился. Оплата запрещена.'); }
  if (!expected || Object.keys(current).some(key => current[key] !== expected[key])) throw sourceError('SOURCE_CHANGED', 'Локальный источник изменился. Оплата запрещена.');
}
export { getSourceTranscript } from './subtitles.mjs';
export { prepareAudio } from './audio.mjs';
export { publicSource } from './public-source.mjs';
