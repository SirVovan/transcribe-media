// Timing validation, duration limiting and caption grouping derive from
// ИИ_монтаж/lib/transcription/format.mjs; adapted to configurable intervals.
function validateTimings(items) {
  let previous = -Infinity;
  for (const item of items) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start || item.start < previous) throw new Error('Некорректные или немонотонные тайминги. Повторная отправка не требуется.');
    previous = item.start;
  }
}
export function limitTimingsToDuration(items, durationSeconds) {
  validateTimings(items);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return items.map(item => ({ ...item }));
  return items.filter(item => item.start < durationSeconds).map(item => ({ ...item, end: Math.min(item.end, durationSeconds) }));
}
function turnsFromWords(words) {
  const turns = [];
  for (const word of words) {
    const previous = turns.at(-1);
    if (previous && previous.speaker === word.speaker && word.start - previous.end <= 0.5) { previous.text += ` ${word.text}`; previous.end = Math.max(previous.end, word.end); }
    else turns.push({ ...word });
  }
  return turns;
}
export function normalizeTranscript(result, { source, language, detectedLanguage, method = 'api', provider, model, diarize, durationSeconds } = {}) {
  if (!result || typeof result !== 'object') throw new Error('Не получен transcript.');
  const warnings = [...(result.warnings || [])]; const duration = durationSeconds ?? result.durationSeconds;
  const all = [...(result.words || []), ...(result.speakerTurns || []), ...(result.captions || [])];
  const speakers = new Map();
  // Already-normalized positive numeric labels remain stable, including gaps.
  const zeroBased = all.some(item => item.speaker === 0);
  const reservedSpeakers = new Set(all.filter(item => Number.isInteger(item.speaker) && item.speaker >= (zeroBased ? 0 : 1)).map(item => zeroBased ? item.speaker + 1 : item.speaker));
  let nextSpeaker = 1;
  const speaker = value => {
    if (value === undefined || value === null || diarize === false) return undefined;
    if (Number.isInteger(value) && value >= (zeroBased ? 0 : 1)) return zeroBased ? value + 1 : value;
    if (!speakers.has(value)) {
      while (reservedSpeakers.has(nextSpeaker)) nextSpeaker++;
      speakers.set(value, nextSpeaker); reservedSpeakers.add(nextSpeaker++);
    }
    return speakers.get(value);
  };
  const items = values => {
    const clean = (values || []).map(item => ({ start: item.start, end: item.end, text: String(item.text ?? '').replace(/\s+/g, ' ').trim(), ...(speaker(item.speaker) === undefined ? {} : { speaker: speaker(item.speaker) }) }));
    validateTimings(clean);
    if (Number.isFinite(duration) && duration > 0 && clean.some(item => item.end > duration || item.start >= duration)) warnings.push('Тайминги за пределами длительности ограничены.');
    return limitTimingsToDuration(clean, duration).filter(item => item.text);
  };
  const words = items(result.words); let speakerTurns = items(result.speakerTurns); let captions = items(result.captions);
  if (!speakerTurns.length && words.length) speakerTurns = turnsFromWords(words);
  if (!captions.length && !words.length) captions = speakerTurns.map(item => ({ ...item }));
  const text = typeof result.text === 'string' ? result.text.trim() : (words.length ? words : speakerTurns.length ? speakerTurns : captions).map(item => item.text).join(' ');
  const detected = detectedLanguage ?? result.detectedLanguage;
  return { schemaVersion: 1, timeUnit: 'seconds', timingOrigin: 'original-media', source: source ?? result.source, language: language ?? result.language, ...(detected ? { detectedLanguage: detected } : {}), method, ...(provider ? { provider } : {}), ...(model ?? result.model ? { model: model ?? result.model } : {}), text, words, speakerTurns, captions, ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}), timingPrecision: words.length ? 'word' : captions.length || speakerTurns.length ? 'phrase' : 'none', warnings: [...new Set(warnings)] };
}
// Blocks on a fixed grid of `interval` seconds (0–30, 30–60, …), as konspekt's youtube_to_srt.py rebucket
// (user decision 16.10): a word or a source phrase goes to the block where it starts; a speaker change splits a block.
// Unlike konspekt, a block starts with its first word, not at the grid mark: subtitles do not appear before speech.
export function buildCaptions(units, options = {}) {
  const interval = typeof options === 'number' ? options : options.interval ?? 30;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('interval должен быть больше нуля.'); validateTimings(units);
  const captions = []; let current, slot;
  for (const unit of units) {
    const unitSlot = Math.floor(unit.start / interval);
    if (current && (unitSlot !== slot || unit.speaker !== current.speaker)) { captions.push(current); current = undefined; }
    if (!current) { current = { ...unit }; slot = unitSlot; }
    else { current.text += ` ${unit.text}`; current.end = Math.max(current.end, unit.end); }
  }
  if (current) captions.push(current);
  // Deepgram sometimes returns overlapping words: a caption ends no later than the next one starts.
  for (let i = 1; i < captions.length; i++) {
    const previous = captions[i - 1], next = captions[i];
    if (previous.end <= next.start) continue;
    if (next.start > previous.start) previous.end = next.start;
    else { next.start = previous.end; next.end = Math.max(next.end, next.start + 0.001); }
  }
  return captions;
}
// Paragraphs of transcript.txt (user decision 16.10): a paragraph ends at a sentence end followed by a pause
// of 2 s or once it reaches ~600 characters; text without punctuation (auto subtitles) may break anywhere.
const sentenceEnd = text => /[.!?…]["»”')\]]*$/.test(text);
function paragraphs(units) {
  const punctuated = units.some(unit => sentenceEnd(unit.text));
  const result = []; let current = '';
  units.forEach((unit, index) => {
    current = current ? `${current} ${unit.text}` : unit.text;
    const next = units[index + 1];
    if (next && (!punctuated || sentenceEnd(unit.text)) && (next.start - unit.end >= 2 || current.length >= 600)) { result.push(current); current = ''; }
  });
  if (current) result.push(current);
  return result.join('\n\n');
}
function time(seconds, separator) {
  const total = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total / 60000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}${separator}${String(total % 1000).padStart(3, '0')}`;
}
function captionText(caption, diarize) { return `${diarize && caption.speaker ? `Спикер ${caption.speaker}: ` : ''}${caption.text.replace(/[\r\n]+/g, ' ')}`; }
export function buildSrt(captions, { diarize = false } = {}) {
  validateTimings(captions); return captions.filter(item => item.end > item.start).map((caption, index) => `${index + 1}\n${time(caption.start, ',')} --> ${time(caption.end, ',')}\n${captionText(caption, diarize)}`).join('\n\n') + '\n';
}
export function buildVtt(captions, { diarize = false } = {}) {
  validateTimings(captions); return 'WEBVTT\n\n' + captions.filter(item => item.end > item.start).map(caption => `${time(caption.start, '.')} --> ${time(caption.end, '.')}\n${captionText(caption, diarize).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n\n') + '\n';
}
export function formatTranscript(transcript, { interval, formats, diarize = false } = {}) {
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Настройте interval больше нуля.');
  if (!Array.isArray(formats) || !formats.length || formats.some(format => !['txt', 'srt', 'vtt'].includes(format))) throw new Error('Выберите допустимые formats.');
  const normalized = normalizeTranscript(transcript, { source: transcript.source, language: transcript.language, method: transcript.method, provider: transcript.provider, model: transcript.model });
  // Source phrases stay in transcript.json, so reformat can regroup them with another interval.
  const blocks = buildCaptions(normalized.words.length ? normalized.words : normalized.captions, { interval });
  if (normalized.words.length) normalized.captions = blocks;
  const warnings = [...normalized.warnings];
  if (normalized.timingPrecision === 'phrase') warnings.push('Субтитры источника содержат тайминги фраз: блоки собраны из целых фраз, граница блока может сдвинуться на длину фразы.');
  if (diarize && ![...normalized.words, ...normalized.speakerTurns, ...normalized.captions].some(item => item.speaker)) warnings.push('Источник не содержит меток спикеров.');
  if (normalized.timingPrecision === 'none' && formats.some(format => format !== 'txt')) warnings.push('Тайминги отсутствуют; SRT/VTT не содержат временных реплик.');
  const files = {};
  if (formats.includes('txt')) files['transcript.txt'] = (diarize && normalized.speakerTurns.length ? normalized.speakerTurns.map(turn => captionText(turn, true)).join('\n\n') : normalized.words.length || normalized.captions.length ? paragraphs(normalized.words.length ? normalized.words : normalized.captions) : normalized.text) + '\n';
  if (formats.includes('srt')) files['transcript.srt'] = buildSrt(blocks, { diarize });
  if (formats.includes('vtt')) files['transcript.vtt'] = buildVtt(blocks, { diarize });
  normalized.warnings = [...new Set(warnings)]; return { files, transcript: normalized, warnings: normalized.warnings };
}
// Entity cleaning and nested voice parsing adapted from Audio-Transcribator
// apps/audio-transcriber-mvp/src/lib/subtitles/{vtt,shared}.ts (read-only source).
function cleanText(raw) {
  return raw.replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&(lt|gt|amp|quot|apos|nbsp);/gi, (_, value) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' })[value.toLowerCase()]).replace(/\s+/g, ' ').trim();
}
function parseTime(raw, format) {
  const match = raw.match(format === 'srt' ? /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/ : /^(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('Некорректный таймкод субтитров.');
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}
function voiceParts(text) {
  const stripped = text.replace(/<(?!\/?v[\s.>])[^>]*>/gi, ''); const parts = []; const stack = [];
  for (const match of stripped.matchAll(/<v([^>]*)>|<\/v\s*>|([^<]+)/gi)) {
    if (match[1] !== undefined) stack.push(match[1].replace(/^\.\S*/, '').trim() || null);
    else if (match[2] !== undefined) { const content = cleanText(match[2]); if (content) parts.push({ name: stack.at(-1) ?? null, text: content }); }
    else stack.pop();
  }
  return parts;
}
export function parseSubtitles(text, { format, source, language, detectedLanguage, automatic = false } = {}) {
  const captions = []; const speakerTurns = []; const ids = new Map(); let hasVoice = false;
  const add = item => { const previous = captions.at(-1); if (!previous || previous.start !== item.start || previous.end !== item.end || previous.text !== item.text || previous.speaker !== item.speaker) captions.push(item); };
  if (format === 'json3') {
    let parsed; try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('Некорректный JSON3 субтитров.'); }
    if (!Array.isArray(parsed?.events)) throw new Error('Некорректный JSON3 субтитров.');
    const events = [];
    for (const event of parsed.events) {
      const content = cleanText((event.segs || []).map(segment => segment.utf8 || '').join(''));
      if (!content) continue;
      if (!Number.isFinite(event.tStartMs) || !Number.isFinite(event.dDurationMs)) throw new Error('JSON3 не содержит тайминги фразы.');
      events.push({ start: event.tStartMs / 1000, end: (event.tStartMs + event.dDurationMs) / 1000, text: content });
    }
    // YouTube shows automatic captions in two rolling rows: a phrase stays on screen until the
    // next-but-one appears. The phrase itself ends where the next one starts.
    events.forEach((event, index) => { const next = events[index + 1]; add(next && next.start > event.start && next.start < event.end ? { ...event, end: next.start } : event); });
  } else if (format === 'srt' || format === 'vtt') {
    const content = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (format === 'vtt' && !/^WEBVTT(?:\s|$)/.test(content)) throw new Error('Отсутствует заголовок WEBVTT.');
    // Only a truly empty line ends a cue: in WebVTT a line of spaces is part of the cue text.
    let previousLine = '';
    for (const block of content.split(format === 'vtt' ? /\n\n+/ : /\n[ \t]*\n/)) {
      const lines = block.split('\n'); if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const arrow = lines.findIndex(line => line.includes('-->')); if (arrow === -1) continue;
      const match = lines[arrow].match(/^\s*(\S+)\s+-->\s+(\S+)/); if (!match) throw new Error('Некорректный таймкод субтитров.');
      const start = parseTime(match[1], format); const end = parseTime(match[2], format);
      let textLines = lines.slice(arrow + 1);
      if (automatic) {
        // Rolling automatic captions: each cue repeats the previous line first, and 10 ms
        // transition cues only repeat text already shown.
        const cleaned = textLines.map(line => cleanText(line)); const last = cleaned.filter(Boolean).at(-1) ?? '';
        if (end - start < 0.05) { previousLine = last || previousLine; continue; }
        let skip = 0; while (skip < cleaned.length && (!cleaned[skip] || cleaned[skip] === previousLine)) skip++;
        previousLine = last || previousLine; textLines = textLines.slice(skip);
      }
      const raw = textLines.join('\n');
      const parts = format === 'vtt' ? voiceParts(raw) : [{ name: null, text: cleanText(raw) }];
      const voice = format === 'vtt' && /<v[\s.>]/i.test(raw); hasVoice ||= voice;
      for (const part of parts) {
        if (!part.text) continue;
        if (part.name !== null) { if (!ids.has(part.name)) ids.set(part.name, ids.size + 1); }
        const item = { start, end, text: part.text, ...(part.name !== null ? { speaker: ids.get(part.name) } : {}) };
        add(item); if (voice) speakerTurns.push({ ...item });
      }
    }
  } else throw new Error('Поддерживаются VTT, SRT и JSON3.');
  if (!captions.length) throw new Error('Дорожка субтитров пуста.');
  const transcript = normalizeTranscript({ text: captions.map(item => item.text).join(' '), words: [], captions, speakerTurns: hasVoice ? speakerTurns : [], warnings: automatic ? ['Автоматические субтитры источника.'] : [] }, { source, language, detectedLanguage, method: 'subtitles' });
  return transcript;
}
export function subtitlesSuitable(transcript, { strategy = 'auto', diarize = false } = {}) {
  if (!transcript || !transcript.text?.trim() || !transcript.captions?.length) return false;
  if (strategy === 'word-timestamps' && transcript.timingPrecision !== 'word') return false;
  if (diarize && !transcript.captions.every(item => Number.isInteger(item.speaker) && item.speaker > 0)) return false;
  return true;
}
