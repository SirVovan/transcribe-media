import { toolTitles } from '../install/index.mjs';

// Тексты хода установки для терминала и чата; панель в браузере использует такие же формулировки.
const extraTitles = { youtube: 'YouTube / EJS', package: 'Скилл' };
export const titleOf = tool => toolTitles[tool] || extraTitles[tool] || tool;
const checkText = { available: 'найден', missing: 'не найден', unusable: 'не запускается', outdated: 'нужна версия новее', unavailable: 'недоступен' };
const operationText = { winget: 'установка через winget', brew: 'установка через Homebrew', pip: 'обновление через pip', verify: 'проверка контрольной суммы', extract: 'распаковка' };
const megabytes = bytes => (bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: bytes < 10485760 ? 1 : 0 });
const files = n => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? 'файлов' : b === 1 ? 'файла' : 'файлов'; };

export function describeEvent(e) {
  if (e.operation === 'service' && e.message === 'Шаг подключения обновлён.') return null;
  if (e.message) return e.tool ? `${titleOf(e.tool)}: ${e.message}` : e.message;
  const name = titleOf(e.tool);
  if (Number.isFinite(e.loaded)) {
    const total = Number.isFinite(e.total) && e.total > 0 ? e.total : null, what = e.operation === 'checksum-download' ? 'контрольная сумма' : 'скачано';
    return `${name}: ${what} ${megabytes(e.loaded)}${total ? ` из ${megabytes(total)} МБ · ${Math.min(100, Math.floor(e.loaded / total * 100))} %` : ' МБ'}`;
  }
  if (Number.isFinite(e.done)) return `${name}: скопировано ${e.done}${Number.isFinite(e.totalFiles) ? ` из ${e.totalFiles} ${files(e.totalFiles)}` : ''}`;
  if (Number.isFinite(e.elapsed)) return `${name}: ${operationText[e.operation] || 'установка'} ${e.status === 'done' ? `завершена за ${e.elapsed} с` : `идёт ${e.elapsed} с`}`;
  if (e.operation === 'check') return e.status === 'running' ? `Проверяется ${name}…` : `${name}: ${checkText[e.status] || e.status}`;
  if (e.tool && operationText[e.operation]) return `${name}: ${operationText[e.operation]}${e.status === 'done' ? ' — готово' : '…'}`;
  if (e.stage === 'install' && e.status === 'planned') return 'План установки готов.';
  if (e.stage === 'install' && ['installed', 'updated'].includes(e.status)) return 'Установка завершена.';
  if (e.stage === 'install' && e.status === 'running') return 'Установка началась.';
  if (e.stage === 'inspect' && e.status === 'done' && !e.tool) return 'Проверка программ завершена.';
  return null;
}

// Прогресс одной операции показываем редко: каждые 10 %, каждые 10 МБ без общего размера, каждые 15 с у внешних установщиков.
export function createProgressFilter() {
  const last = new Map();
  return e => {
    const key = `${e.tool}:${e.operation}`;
    let bucket;
    if (Number.isFinite(e.loaded)) bucket = Number.isFinite(e.total) && e.total > 0 ? Math.floor(e.loaded / e.total * 10) : Math.floor(e.loaded / 10485760);
    else if (Number.isFinite(e.done)) bucket = e.done === e.totalFiles ? 'all' : Math.floor(e.done / Math.max(1, e.totalFiles || 1) * 4);
    else if (Number.isFinite(e.elapsed)) bucket = e.status === 'done' ? 'done' : Math.floor(e.elapsed / 15);
    else return true;
    if (e.status === 'done' && !Number.isFinite(e.elapsed)) return last.get(key) !== 'final' && (last.set(key, 'final'), true);
    if (last.get(key) === bucket) return false;
    last.set(key, bucket); return true;
  };
}
