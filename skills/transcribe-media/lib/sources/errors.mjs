// Source messages are fixed texts without paths, URLs or tool output, so the CLI may show them.
export function sourceError(code, message) { return Object.assign(new Error(message), { code, cliSafe: true }); }
// Inspect private diagnostics only for classification; never expose their contents.
export function accessError(diagnostic = '', status) {
  if (status === 429 || /429|too many requests|rate.limit/i.test(diagnostic)) return sourceError('SOURCE_RATE_LIMIT', 'Источник ограничил частоту запросов. Повторите позже.');
  if (status === 401 || /login|log.in|sign.in|cookies|authentication|private video/i.test(diagnostic)) return sourceError('SOURCE_LOGIN_REQUIRED', 'Источник требует входа. Cookies допускаются только с явным разрешением.');
  if (status === 403 || /forbidden|blocked|geo.restrict|not available in your country|captcha/i.test(diagnostic)) return sourceError('SOURCE_BLOCKED', 'Доступ к источнику ограничен.');
  if (status === 404 || status === 410 || /removed|deleted|unavailable|not found|does not exist/i.test(diagnostic)) return sourceError('SOURCE_UNAVAILABLE', 'Источник удалён или недоступен.');
  if (/timeout|timed out|network|connection|dns|resolve|certificate|socket/i.test(diagnostic)) return sourceError('SOURCE_NETWORK', 'Не удалось получить источник из-за сетевой ошибки.');
  return sourceError('SOURCE_PROCESS_FAILED', 'Не удалось обработать источник. Проверьте доступ и необходимые инструменты.');
}
