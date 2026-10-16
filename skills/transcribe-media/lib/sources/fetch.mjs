import { accessError, sourceError } from './errors.mjs';
export async function sourceResponse(url, { fetchImpl = fetch, signal, headers, timeoutMs = 120000 } = {}) {
  const validate = value => { let parsed; try { parsed = new URL(value); } catch { throw sourceError('SOURCE_URL', 'Источник предоставил некорректный URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw sourceError('SOURCE_URL', 'Источник предоставил недопустимый URL.'); return parsed; };
  let current = validate(url); let forwardedHeaders = headers;
  let response;
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; ; redirects++) {
    try { response = await fetchImpl(current.href, { signal: boundedSignal, headers: forwardedHeaders, redirect: 'manual' }); } catch (error) { throw sourceError(error.name === 'AbortError' ? 'SOURCE_ABORTED' : 'SOURCE_NETWORK', error.name === 'AbortError' ? 'Загрузка источника отменена.' : 'Не удалось загрузить источник.'); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel().catch(() => {});
    if (redirects >= 5) throw sourceError('SOURCE_REDIRECT_LIMIT', 'Источник превысил предел перенаправлений.');
    const location = response.headers?.get('location');
    if (!location) throw sourceError('SOURCE_URL', 'Источник предоставил некорректное перенаправление.');
    let target; try { target = new URL(location, current); } catch { throw sourceError('SOURCE_URL', 'Источник предоставил некорректное перенаправление.'); }
    target = validate(target.href);
    if (target.origin !== current.origin) forwardedHeaders = undefined;
    current = target;
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw accessError('', response.status); }
  return response;
}
export async function limitedText(response, maxBytes = 16 * 1024 * 1024) {
  if (Number(response.headers?.get('content-length')) > maxBytes) { await response.body?.cancel(); throw sourceError('SOURCE_OUTPUT_LIMIT', 'Дорожка субтитров слишком велика.'); }
  const chunks = []; let length = 0;
  try {
    for await (const chunk of response.body || []) { length += chunk.byteLength; if (length > maxBytes) throw sourceError('SOURCE_OUTPUT_LIMIT', 'Дорожка субтитров слишком велика.'); chunks.push(Buffer.from(chunk)); }
  } catch (error) { if (error.code === 'SOURCE_OUTPUT_LIMIT') throw error; throw sourceError('SOURCE_NETWORK', 'Чтение субтитров прервано.'); }
  return Buffer.concat(chunks).toString('utf8');
}
