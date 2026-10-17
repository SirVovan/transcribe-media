import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { fingerprint } from './fingerprint.mjs';
import { sourceError } from './errors.mjs';
import { inspectTikTok } from './tiktok.mjs';
import { inspectInstagram } from './instagram.mjs';
import { inspectYouTube } from './youtube.mjs';
import { inspectMetadata, metadataSource } from './yt-dlp.mjs';

// The file name in a URL is percent-encoded: %D0%9B%D0%B5… is «Ле…».
function urlTitle(pathname) {
  let name = path.posix.basename(pathname);
  try { name = decodeURIComponent(name); } catch { /* malformed escape: keep the name as is */ }
  return path.posix.basename(name, path.posix.extname(name)) || 'media';
}
// A name from macOS may hold «й» and «ё» decomposed (NFD) while the typed path has them composed, or the other way
// round; Windows compares names literally. Each missing component is looked up among its siblings by NFC form.
async function otherUnicodeForm(target) {
  const { root } = path.parse(target); let current = root;
  for (const name of target.slice(root.length).split(path.sep).filter(Boolean)) {
    const direct = path.join(current, name);
    if (await lstat(direct).then(() => true, () => false)) { current = direct; continue; }
    const wanted = name.normalize('NFC'), match = (await readdir(current).catch(() => [])).find(entry => entry.normalize('NFC') === wanted);
    if (!match) return null;
    current = path.join(current, match);
  }
  return current;
}
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
    if (/\.(?:mp3|mp4|m4a|wav|flac|ogg|opus|webm|mov|aac|mkv)(?:$)/i.test(url.pathname)) return { type: 'direct', input, identity: `urlsha256:${createHash('sha256').update(input).digest('hex')}`, title: urlTitle(url.pathname) };
    return metadataSource('remote', input, await inspectMetadata(input, options));
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(input)) throw sourceError('SOURCE_INPUT', 'Поддерживаются только HTTP/HTTPS URL и локальные файлы.');
  let localPath = path.resolve(cwd, input), value;
  try { value = await fingerprint(localPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const found = await otherUnicodeForm(localPath);
    if (!found) throw sourceError('SOURCE_NOT_FOUND', 'Локальный источник не найден.');
    localPath = found; value = await fingerprint(localPath);
  }
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
