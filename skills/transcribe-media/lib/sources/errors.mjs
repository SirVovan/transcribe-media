// Source messages are fixed texts without paths, URLs or tool output, so the CLI may show them.
// The only exception is the tool's own ERROR line for an unrecognized failure, cleaned by toolReason.
export function sourceError(code, message) { return Object.assign(new Error(message), { code, cliSafe: true }); }
// yt-dlp prints the cause in ERROR lines; WARNING lines (for example a retried 429) must not decide the category.
function errorLines(diagnostic) { return String(diagnostic).split(/\r?\n/).filter(line => /^ERROR\b/.test(line.trim())); }
// The tool's ERROR line without addresses, paths, proxy credentials and the "please report" boilerplate.
export function toolReason(line) {
  const text = String(line).trim().replace(/^ERROR:?\s*/, '')
    .replace(/;?\s*please report this issue on.*$/i, '').replace(/\s*Confirm you are on the latest version.*$/i, '')
    // Paths may hold Cyrillic and spaces: a quoted path goes whole; an unquoted one up to its last separator and file name.
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<адрес>').replace(/(['"])(?:[A-Za-z]:\\|\\\\|\/)[^'"\r\n]*\1/g, '$1<путь>$1')
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n'"]*\\)*[^\s'"\\]*/g, '<путь>').replace(/\\\\[^\s'"]+/g, '<путь>').replace(/(?<![\p{L}\p{N}_.<])\/(?:[^\/\s'"][^\/\r\n'"]*\/)+[^\s'"\/]*/gu, '<путь>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? text.slice(0, 299) + '…' : text;
}
// Inspect private diagnostics for classification; only toolReason of an ERROR line may reach the message.
export function accessError(diagnostic = '', status) {
  const errors = errorLines(diagnostic), focus = errors.length ? errors.join('\n') : String(diagnostic);
  if (/not a bot/i.test(focus)) return sourceError('SOURCE_BOT_CHECK', 'Источник принял запрос за автоматический. Повторите позже; если подключение идёт через прокси или VPN, попробуйте прямое: флаг --source-proxy direct.');
  if (status === 429 || /429|too many requests|rate.limit/i.test(focus)) return sourceError('SOURCE_RATE_LIMIT', 'Источник ограничил частоту запросов. Повторите позже.');
  if (/unsupported url/i.test(focus)) return sourceError('SOURCE_UNSUPPORTED', 'Сайт или страница не поддерживается: yt-dlp не нашёл здесь видео. Скачайте видео сами и укажите файл.');
  if (status === 401 || /login|log.in|sign.in|cookies|authentication|private video/i.test(focus)) return sourceError('SOURCE_LOGIN_REQUIRED', 'Источник требует входа. Cookies допускаются только с явным разрешением.');
  if (status === 403 || /forbidden|blocked|geo.restrict|not available in your country|captcha/i.test(focus)) return sourceError('SOURCE_BLOCKED', 'Доступ к источнику ограничен.');
  if (status === 404 || status === 410 || /removed|deleted|unavailable|not found|does not exist/i.test(focus)) return sourceError('SOURCE_UNAVAILABLE', 'Источник удалён или недоступен.');
  if (/timeout|timed out|network|connection|dns|resolve|certificate|socket/i.test(focus)) return sourceError('SOURCE_NETWORK', 'Не удалось получить источник из-за сетевой ошибки.');
  const reason = errors.length ? toolReason(errors.at(-1)) : '';
  return sourceError('SOURCE_PROCESS_FAILED', reason ? `Не удалось обработать источник. Ответ yt-dlp: «${reason}».` : 'Не удалось обработать источник. Проверьте доступ и необходимые инструменты.');
}
