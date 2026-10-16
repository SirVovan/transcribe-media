import { spawn } from 'node:child_process';
import { sourceError, accessError } from './errors.mjs';

export function runProcess(executable, args, { signal, cwd, timeoutMs = 120000, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child; let stdout = ''; let stderr = ''; let bytes = 0; let overflow = false;
    try { child = spawn(executable, args, { shell: false, windowsHide: true, signal, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(sourceError('SOURCE_TOOL', 'Не удалось запустить инструмент источника.')); return; }
    const timer = setTimeout(() => { child.kill(); reject(sourceError('SOURCE_TIMEOUT', 'Превышено время обработки источника.')); }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > maxOutputBytes) { overflow = true; child.kill(); } else stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.on('error', error => { clearTimeout(timer); reject(sourceError(error.name === 'AbortError' ? 'SOURCE_ABORTED' : 'SOURCE_TOOL', error.name === 'AbortError' ? 'Обработка источника отменена.' : 'Инструмент источника недоступен.')); });
    child.on('close', code => { clearTimeout(timer); if (overflow) reject(sourceError('SOURCE_OUTPUT_LIMIT', 'Источник вернул слишком большой ответ.')); else resolve({ stdout, stderr, code }); });
  });
}
export async function checkedProcess(executable, args, options = {}) {
  const runner = options.runProcess || runProcess; let result;
  try { result = await runner(executable, args, { signal: options.signal, cwd: options.cwd, shell: false, windowsHide: true, timeoutMs: options.timeoutMs }); }
  catch (error) { if (String(error.code || '').startsWith('SOURCE_')) throw error; if (error.name === 'AbortError') throw sourceError('SOURCE_ABORTED', 'Обработка источника отменена.'); throw accessError(String(error.message)); }
  if (!result || result.code !== 0) throw accessError(String(result?.stderr || ''));
  return result;
}
