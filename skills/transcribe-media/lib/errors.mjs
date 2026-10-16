// System file errors get a plain explanation instead of the generic phrase (review finding 8).
// The original message may contain private paths, so only the code is used.
const fileSystemTexts = {
  EACCES: ['FS_ACCESS', 'Нет доступа к файлу или папке: не хватает прав. Проверьте права на папку или выберите другую.'],
  EPERM: ['FS_ACCESS', 'Нет доступа к файлу или папке: не хватает прав. Проверьте права на папку или выберите другую.'],
  EROFS: ['FS_ACCESS', 'Папка доступна только для чтения. Выберите другую папку.'],
  ENOSPC: ['FS_NO_SPACE', 'На диске закончилось место. Освободите место и повторите.'],
  EBUSY: ['FS_BUSY', 'Файл занят другой программой. Закройте её и повторите.'],
};
export function fileSystemError(error) {
  const entry = fileSystemTexts[error?.code];
  return entry ? { code: entry[0], message: entry[1] } : null;
}
