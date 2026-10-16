import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { sourceError } from './errors.mjs';

export async function fingerprint(file) {
  const before = await stat(file); if (!before.isFile()) throw sourceError('SOURCE_NOT_FILE', 'Укажите локальный аудио- или видеофайл.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw sourceError('SOURCE_CHANGED', 'Источник изменился во время чтения.');
  return { sha256: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino };
}
