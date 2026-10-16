# transcribe-media

Скилл для Claude Code и Codex: расшифровывает локальные аудио- и видеофайлы, а также доступные ссылки YouTube, TikTok и Instagram Reels. Сначала ищет готовые субтитры и кэш, а распознавание отправляет в Deepgram или AssemblyAI только с вашего согласия. Результат — текст и субтитры (TXT, SRT, VTT).

Проверено на Windows. На macOS и Linux не проверялось.

## Установка

Нужен Claude Code или Codex на компьютере (приложение, CLI или расширение редактора). Браузерный чат без доступа к компьютеру установить скилл не сможет.

### Проще всего: попросите ассистента

Откройте любую локальную папку в Claude Code или Codex и напишите:

```text
Прочитай README репозитория https://github.com/SirVovan/transcribe-media и установи скилл transcribe-media по разделу «Для ИИ-ассистента»: скачай архив репозитория и запусти мастер установки.
```

Ассистент скачает пакет, запустит мастер установки и проведёт по шагам: проверит программы (Node.js, FFmpeg, yt-dlp), после вашего согласия поставит недостающие, откроет страницу настроек для ключа сервиса распознавания. Вопросы задаются в чате, ход установки виден на странице в браузере.

Если ассистент только скопировал папку скилла и на этом закончил (так делает встроенный установщик скиллов Codex), напишите следующим сообщением в том же чате «Настрой transcribe-media» — мастер поставит программы и второй скилл `transcribe-settings`.

### Claude Code: каталог плагинов

```text
/plugin marketplace add SirVovan/transcribe-media
/plugin install transcribe-media@transcribe-media
```

Затем в новом чате напишите «Настрой transcribe-media» — ассистент пройдёт первую настройку. Обновления приходят через `/plugin`.

### Codex и другие ассистенты: npx skills

Нужен Node.js 22 или новее.

```text
npx skills add SirVovan/transcribe-media -g -a codex
```

Отметьте оба скилла (`transcribe-media` и `transcribe-settings`). Затем в новом чате напишите «Настрой transcribe-media».

### Без чата (Windows)

Скачайте [архив](https://github.com/SirVovan/transcribe-media/archive/refs/heads/main.zip), распакуйте его в отдельную папку и дважды щёлкните `Установить.cmd`. Мастер задаёт вопросы в терминале. На macOS/Linux запустите `sh start.sh` из распакованной папки.

## Для ИИ-ассистента: установка по ссылке на этот репозиторий

Если пользователь просит установить скилл по ссылке на этот репозиторий, не используй встроенный установщик скиллов клиента (в Codex — `skill-installer`): он копирует одну папку и не ставит программы. Действуй так:

1. Скажи пользователю, что скачаешь архив репозитория с GitHub и куда. Git не нужен. В Codex выполняй команды вне песочницы: им нужна сеть и домашняя папка пользователя.

   Windows (PowerShell):

   ```powershell
   $dir = Join-Path $env:LOCALAPPDATA 'transcribe-media-package'
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
   Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/SirVovan/transcribe-media/archive/refs/heads/main.zip' -OutFile (Join-Path $dir 'main.zip')
   Expand-Archive -Force -LiteralPath (Join-Path $dir 'main.zip') -DestinationPath $dir
   ```

   macOS/Linux:

   ```sh
   dir="$HOME/.local/share/transcribe-media-package"; mkdir -p "$dir"
   curl -fsSL -o "$dir/main.zip" https://github.com/SirVovan/transcribe-media/archive/refs/heads/main.zip
   unzip -oq "$dir/main.zip" -d "$dir"
   ```

   Корень пакета — папка `transcribe-media-main` внутри `$dir`.

2. Прочитай `<корень-пакета>/skills/transcribe-media/references/install.md` и пройди установку по нему в режиме «Пакет». Все согласия из инструкции обязательны.

## После установки

Попросите ассистента расшифровать файл или ссылку:

```text
Расшифруй файл «D:\Видео\интервью.mp4». Сохрани текст и субтитры.
```

Перед возможной платной отправкой аудио ассистент показывает способ обработки и параметры и спрашивает согласие. Доступность ролика по ссылке зависит от сайта и прав доступа.

## Подключить сервис распознавания

После установки мастер сам открывает в браузере страницу настроек. Позже её открывает просьба в чате («Открой настройки транскрибации») или команда `/transcribe-settings` (в плагине Claude Code — `/transcribe-media:transcribe-settings`, в Codex — `$transcribe-settings`). На странице — карточки Deepgram и AssemblyAI со ссылками на регистрацию и создание ключа, поле ключа и кнопка «Сохранить и проверить», а также настройки расшифровки. Кабинет сервиса вы открываете и проходите сами.

Кнопка «Сохранить и проверить» отправляет сервису один бесплатный проверочный запрос без аудио. Ключ, который сервис не принял, не сохраняется. Ключ вводите только на странице, не в чате. Он хранится в папке пользователя ОС. По умолчанию язык определяется автоматически, длина одной строки субтитров — 30 секунд.

## Ручной CLI

```text
node "<папка-скилла>/scripts/cli.mjs" help
```

Сценарии — в [руководстве CLI](skills/transcribe-media/references/usage.md), справка по сервисам — в [providers.md](skills/transcribe-media/references/providers.md). Что проверено вживую, а что нет — в [docs/limitations.md](docs/limitations.md).

## Лицензия

[MIT](LICENSE).
