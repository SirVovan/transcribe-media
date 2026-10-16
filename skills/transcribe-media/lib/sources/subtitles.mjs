import { parseSubtitles, subtitlesSuitable } from '../transcript/index.mjs';
import { publicSource } from './public-source.mjs';
import { sourceResponse, limitedText } from './fetch.mjs';
import { sourceError } from './errors.mjs';

function languageCode(language) {
  const value = String(language || '').toLowerCase().replace(/_/g, '-');
  return ({ russian: 'ru', русский: 'ru', rus: 'ru', english: 'en', английский: 'en', eng: 'en' })[value] || value;
}
const base = code => code.replace(/-orig$/, '').split('-')[0];
// YouTube offers machine translations of automatic captions into any language.
// Only the original track (`-orig` or the video language) is a transcript.
function candidates(tracks, language, { automatic, sourceLanguage }) {
  const requested = languageCode(language); const auto = requested === 'auto';
  const original = sourceLanguage ? base(languageCode(sourceLanguage)) : '';
  const keys = Object.keys(tracks || {});
  const matches = keys.filter(lang => {
    const code = languageCode(lang);
    if (automatic && !code.endsWith('-orig') && !(original && base(code) === original)) return false;
    if (auto) return original ? base(code) === original : automatic || keys.length === 1;
    const plain = code.replace(/-orig$/, '');
    return plain === requested || (!requested.includes('-') && base(plain) === requested);
  }).sort((a, b) => rank(a) - rank(b));
  function rank(lang) { const code = languageCode(lang); return auto ? (code.endsWith('-orig') ? 0 : 1) : code.replace(/-orig$/, '') === requested ? 0 : 1; }
  // Automatic YouTube VTT rolls lines over; json3 holds each phrase once.
  const order = automatic ? ['json3', 'vtt', 'srt'] : ['vtt', 'srt', 'json3'];
  return matches.flatMap(lang => (tracks[lang] || []).filter(track => order.includes(track.ext) && (track.url || typeof track.data === 'string')).map(track => ({ ...track, language: lang }))).sort((a, b) => order.indexOf(a.ext) - order.indexOf(b.ext));
}
export async function getSourceTranscript(source, options = {}) {
  const { config = {} } = options;
  if (source.type === 'local' || source.type === 'direct') return null;
  const tracks = source.subtitleTracks || { native: source.metadata?.subtitles || {}, automatic: source.metadata?.automatic_captions || {} };
  for (const [kind, automatic] of [['native', false], ['automatic', true]]) {
    for (const track of candidates(tracks[kind], config.language, { automatic, sourceLanguage: source.metadata?.language })) {
      const headers = { ...(source.metadata?.http_headers || {}), ...(track.http_headers || {}) };
      if (config.sourceAccess?.allowCookies !== true) for (const name of Object.keys(headers)) if (/^(cookie|authorization)$/i.test(name)) delete headers[name];
      const text = typeof track.data === 'string' ? track.data : await limitedText(await sourceResponse(track.url, { ...options, headers }));
      let transcript;
      const trackLanguage = languageCode(track.language).replace(/-orig$/, '');
      const auto = languageCode(config.language) === 'auto';
      try { transcript = parseSubtitles(text, { format: track.ext, source: publicSource(source), language: auto ? trackLanguage : languageCode(config.language), ...(auto ? { detectedLanguage: trackLanguage } : {}), automatic }); }
      catch { throw sourceError('SOURCE_SUBTITLES_INVALID', 'Дорожка субтитров пуста или содержит некорректные тайминги.'); }
      if (subtitlesSuitable(transcript, { strategy: config.strategy || 'auto', diarize: config.diarize })) return transcript;
    }
  }
  return null;
}
