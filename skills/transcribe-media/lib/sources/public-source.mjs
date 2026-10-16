import { createHash } from 'node:crypto';

const cleanText = text => String(text).replace(/https?:\/\/\S+/gi, '[ссылка]').replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
function canonicalUrl(source) {
  try {
    const url = new URL(source.canonicalUrl); if (url.username || url.password || url.protocol !== 'https:') return;
    const rules = { youtube: /^(?:www\.)?youtube\.com$/, tiktok: /^(?:www\.)?tiktok\.com$/, instagram: /^(?:www\.)?instagram\.com$/ };
    if (!rules[source.type]?.test(url.hostname)) return;
    if (source.type === 'youtube') { const id = url.searchParams.get('v'); if (url.pathname !== '/watch' || !/^[\w-]+$/.test(id || '')) return; return `https://www.youtube.com/watch?v=${id}`; }
    if (source.type === 'tiktok' && !/^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)) return;
    if (source.type === 'instagram' && !/^\/(?:reel|reels|p|tv)\/[\w-]+\/?$/.test(url.pathname)) return;
    return `${url.origin}${url.pathname}`;
  } catch { return; }
}
// Whitelist only. Private metadata, CDN URLs, headers and cookies never persist.
export function publicSource(source) {
  if (!source || typeof source !== 'object') return {};
  const type = ['local', 'youtube', 'tiktok', 'instagram', 'direct', 'remote'].includes(source.type) ? source.type : 'remote';
  const identity = /^[\w:-]+$/.test(source.identity || '') ? source.identity : `sha256:${createHash('sha256').update(String(source.identity || '')).digest('hex')}`;
  const result = { type, identity, title: cleanText(source.title || 'media') };
  const url = canonicalUrl(source); if (url) result.canonicalUrl = url;
  if (Number.isFinite(source.durationSeconds) && source.durationSeconds > 0) result.durationSeconds = source.durationSeconds;
  if (type === 'local' && typeof source.localPath === 'string') result.localPath = source.localPath;
  if (type === 'local' && /^[a-f0-9]{64}$/.test(source.fingerprint?.sha256 || '')) result.fingerprint = Object.fromEntries(['sha256', 'size', 'mtimeMs', 'ctimeMs', 'ino'].filter(key => typeof source.fingerprint[key] === 'number' || key === 'sha256').map(key => [key, source.fingerprint[key]]));
  return result;
}
