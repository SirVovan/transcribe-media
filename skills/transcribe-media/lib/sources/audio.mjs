import path from 'node:path';
import { mkdir, readdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { checkedProcess } from './process.mjs';
import { callYtdlp, audioFormat } from './yt-dlp.mjs';
import { sourceResponse } from './fetch.mjs';
import { sourceError } from './errors.mjs';
import { fingerprint } from './fingerprint.mjs';

const ownedFiles = new Map();
const temporaryName = name => /^(?:source\.|audio\.flac$)/.test(name);
const stamp = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
async function safeDirectory(directory) {
  const absolute = path.resolve(directory); let component = path.parse(absolute).root;
  for (const name of absolute.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, name);
    const info = await lstat(component);
    if (!info.isDirectory() || info.isSymbolicLink()) throw sourceError('SOURCE_TEMP_UNSAFE', 'Временная папка содержит ссылку или недопустимый путь.');
  }
}
async function freshTargets(tempDir) {
  const existing = [];
  for (const name of await readdir(tempDir)) if (temporaryName(name)) {
    const file = await safeFile(tempDir, path.join(tempDir, name));
    if (ownedFiles.get(file) !== stamp(await lstat(file))) throw sourceError('SOURCE_TEMP_UNSAFE', 'Временная папка содержит чужой файл.');
    existing.push(file);
  }
  for (const file of existing) { await unlink(file); ownedFiles.delete(file); }
}

async function safeFile(tempDir, file) {
  await safeDirectory(tempDir);
  const root = await realpath(tempDir); const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw sourceError('SOURCE_TEMP_UNSAFE', 'Временный файл не прошёл проверку безопасности.');
  const target = await realpath(file); const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || path.relative(root, path.dirname(target)) !== '') throw sourceError('SOURCE_TEMP_UNSAFE', 'Инструмент вернул путь вне временной папки.');
  return path.resolve(file);
}
async function trackFiles(tempDir, registerTemp) {
  for (const name of await readdir(tempDir)) if (temporaryName(name)) {
    const file = await safeFile(tempDir, path.join(tempDir, name));
    ownedFiles.set(file, stamp(await lstat(file)));
    if (registerTemp) await registerTemp(file);
  }
}
async function downloadSource(source, options) {
  const { tempDir } = options;
  try {
    if (source.type === 'direct') {
      // A long recording may download for longer than any fixed limit: only a stall aborts it.
      const idleMs = options.downloadIdleMs ?? 60_000; const idle = new AbortController(); let timer;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), idleMs); };
      const target = path.join(tempDir, 'source.media');
      try {
        touch();
        const response = await sourceResponse(source.input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal, timeoutMs: 2_147_483_647 });
        const handle = await open(target, 'wx');
        const reader = response.body?.getReader(); const stop = () => reader?.cancel().catch(() => {});
        idle.signal.addEventListener('abort', stop, { once: true });
        try {
          // cancel() ends a pending read as done, so a stall is detected by the flag, not by an error.
          for (;;) { const { done, value } = reader ? await reader.read() : { done: true }; if (idle.signal.aborted) throw new Error('stalled'); if (done) break; touch(); await handle.writeFile(value); }
        } catch { throw sourceError('SOURCE_NETWORK', idle.signal.aborted ? `Загрузка медиа остановилась: ${Math.round(idleMs / 1000)} с нет новых данных. Временные файлы сохранены.` : 'Загрузка медиа прервана. Временные файлы сохранены.'); }
        finally { await handle.close(); }
      } catch (error) { if (idle.signal.aborted && error.code === 'SOURCE_ABORTED' && !options.signal?.aborted) throw sourceError('SOURCE_NETWORK', `Загрузка медиа остановилась: ${Math.round(idleMs / 1000)} с нет новых данных.`); throw error; }
      finally { clearTimeout(timer); }
      return target;
    }
    // yt-dlp aborts stalled sockets itself (--socket-timeout); the overall limit only guards a hung tool.
    const timeoutMs = 30 * 60_000 + (Number.isFinite(source.durationSeconds) ? source.durationSeconds * 1000 : 0);
    const result = await callYtdlp(['--no-cache-dir', '--no-write-info-json', '--no-write-thumbnail', '--no-continue', '--no-overwrites', '--paths', `home:${tempDir}`, '--paths', `temp:${tempDir}`, '-f', audioFormat(source), '-o', path.join(tempDir, 'source.%(ext)s'), '--print', 'after_move:filepath', '--', source.canonicalUrl || source.input], { ...options, timeoutMs });
    const file = String(result.stdout || '').trim().split(/\r?\n/).at(-1);
    if (!file) throw sourceError('SOURCE_DOWNLOAD', 'Инструмент не сообщил путь скачанного медиа.');
    try { return await safeFile(tempDir, path.resolve(tempDir, file)); }
    catch (error) { if (error.code === 'ENOENT') throw sourceError('SOURCE_DOWNLOAD', 'Медиа скачано, но файл не найден по пути, который сообщил yt-dlp. Временные файлы сохранены.'); throw error; }
  } finally { await trackFiles(tempDir, options.registerTemp); }
}
export async function prepareAudio(source, options = {}) {
  const { config = {}, registerTemp } = options;
  if (!options.tempDir || !path.isAbsolute(options.tempDir)) throw sourceError('SOURCE_TEMP_REQUIRED', 'Укажите абсолютную временную папку задания.');
  await mkdir(options.tempDir, { recursive: true }); const tempDir = path.resolve(options.tempDir); await safeDirectory(tempDir); await freshTargets(tempDir); options = { ...options, tempDir, accessCwd: options.cwd || process.cwd(), cwd: tempDir };
  const input = source.type === 'local' ? source.localPath : await downloadSource(source, options);
  if (source.type === 'direct') {
    // Stat/ino belong to this job's private copy, not the recognition identity.
    const value = await fingerprint(await safeFile(tempDir, input));
    source.localPath = input; source.downloadFingerprint = value; source.identity = `sha256:${value.sha256}`;
  }
  const probe = await checkedProcess(config.tools?.ffprobe || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], options);
  let metadata; try { metadata = JSON.parse(probe.stdout); } catch { throw sourceError('SOURCE_PROBE', 'Не удалось прочитать параметры аудио.'); }
  const streams = (metadata.streams || []).filter(stream => stream.codec_type === 'audio');
  if (!streams.length) throw sourceError('SOURCE_NO_AUDIO', 'Источник не содержит аудиопоток.');
  const durationSeconds = Number(streams[0].duration || metadata.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw sourceError('SOURCE_DURATION', 'Не удалось определить длительность аудио.');
  const warnings = streams.length > 1 ? ['В источнике несколько аудиопотоков; используется первый.'] : [];
  const audioPath = path.join(tempDir, 'audio.flac');
  try { const existing = await lstat(audioPath); if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) throw sourceError('SOURCE_TEMP_UNSAFE', 'Временный аудиофайл не прошёл проверку безопасности.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await checkedProcess(config.tools?.ffmpeg || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', audioPath], { ...options, timeoutMs: 30 * 60 * 1000 });
    await safeFile(tempDir, audioPath);
  } finally { await trackFiles(tempDir, registerTemp); }
  return { audioPath, durationSeconds, warnings };
}
