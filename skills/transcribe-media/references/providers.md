# Deepgram и AssemblyAI

## Подключение аккаунта и проверка ключа

Ключи вводятся на локальной странице настроек `/setup` (команда `installer.mjs settings`, скилл `/transcribe-settings` или кнопка «Настройки» в панели установки). Карточки Deepgram и AssemblyAI идут друг под другом: «Регистрация» и «Создать ключ» со ссылками, скрытое поле ключа и кнопка «Сохранить и проверить», подробная инструкция, ссылки «Кабинет», «Цены», «Справка API». Пользователь сам регистрируется, входит и создаёт ключ на сайте сервиса. Ссылки и пути в кабинете сверены по официальной документации 15.10.2026.

| Сервис | Регистрация | Создать ключ |
| --- | --- | --- |
| Deepgram | <https://console.deepgram.com/signup?jump=keys> | <https://console.deepgram.com/> → Projects → Settings → API Keys → Create a New API Key |
| AssemblyAI | <https://www.assemblyai.com/dashboard/signup> | <https://www.assemblyai.com/dashboard/api-keys> → Workspace → Manage → API Keys → Create New API Key |

Не просите ключ в чате, не включайте его в команду или файл. В терминале ключ вводится скрыто: `installer.mjs connect` или `cli.mjs provider add NAME`. Ключ хранится для пользователя ОС; область установки `project` и `--config` не создают отдельного хранилища по проекту. Ключ из переменной окружения (`DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`) важнее сохранённого, страница его не удаляет.

Нажатие «Сохранить и проверить» — согласие на один бесплатный запрос без аудио; ключ записывается только после ответа сервиса:

- Deepgram — `GET https://api.deepgram.com/v1/auth/token` (`Authorization: Token <ключ>`);
- AssemblyAI — `GET https://api.assemblyai.com/v2/transcript?limit=1` (`Authorization: <ключ>`); тело ответа не читается, там сведения о последнем задании пользователя.

| Ответ | Ключ | Текст |
| --- | --- | --- |
| 2xx | сохраняется | «Ключ проверен ДД.ММ» |
| 401 | не сохраняется | «Сервис не принял ключ. Проверьте, что скопировали его целиком» |
| 403 | не сохраняется | «У ключа недостаточно прав» |
| 429, 5xx, сеть, тайм-аут | сохраняется со статусом «не проверен» | «Не удалось связаться с сервисом. Ключ сохранён; нажмите „Проверить снова“» |

Проверка подтверждает только авторизацию — не баланс, модель, язык или качество. Перенаправления запрещены. Баланс через API не запрашивается; ссылки на страницу баланса нет, потому что её адрес содержит номер проекта пользователя. Проверка привязана к сохранённому ключу: после замены ключа статус снова «не проверен».

Основной сервис — тот, через который идёт расшифровка. Если у основного сервиса нет ключа, основным становится сервис, ключ которого только что сохранён; иначе — кнопкой «Сделать основным».

## Выбор модели и языка

| Провайдер | Модель пакета по умолчанию | Доступные модели пакета | Подсказка числа спикеров |
| --- | --- | --- | --- |
| Deepgram | `nova-3` | `nova-3`, `nova-2` | Не поддерживается |
| AssemblyAI | `universal-2` | `universal-2`, `universal-3-5-pro` | `speakers_expected`, включая 1 |

Язык по умолчанию — `auto` (автоопределение). Deepgram получает `detect_language=true` без `language`; определённый язык — `results.channels[].detected_language` ([Language Detection](https://developers.deepgram.com/docs/language-detection)). AssemblyAI получает `language_detection: true` и `language_detection_options: {expected_languages: ['ru','en'], fallback_language: 'ru'}`: запасной язык обязан входить в список ожидаемых, а список — подсказка, не фильтр; определённый язык — `language_code` в ответе ([Automatic Language Detection](https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/automatic-language-detection)). Определённый язык записывается в `transcript.json` (`language`, `detectedLanguage`), ответ CLI содержит строку `languageNote` «Определён язык: …». Ключ кэша различает `auto` и явный код.

Явный код Deepgram получает через `language`. Nova-3 поддерживает русский (`ru`); полный перечень сочетаний языка и модели находится в [Models & Languages Overview](https://developers.deepgram.com/docs/models-languages-overview). Пакет не заменяет неизвестный язык русским или английским и не меняет выбранную модель. Страница настроек предлагает 59 кодов, общих для Nova-3 и Universal-2.

Пакет также знает документированные варианты Nova для pre-recorded API: `nova-3-medical`, `nova-3-pharma` и модели Nova-2 `meeting`, `phonecall`, `finance`, `conversationalai`, `voicemail`, `video`, `medical`, `drivethru`, `automotive`, `atc`; суффиксы `-general` приводятся к `nova-3` или `nova-2`. Сочетание модели и языка проверяется по зафиксированной таблице [Deepgram Models & Languages Overview](https://developers.deepgram.com/docs/models-languages-overview), сверенной 10 октября 2026 года. Несовместимая пара отклоняется до платного запроса; живой API этим не проверяется.

У AssemblyAI Universal-2 поддерживает 99 языков, в том числе русский. Universal-3.5 Pro поддерживает 18 языков: `en`, `es`, `fr`, `de`, `it`, `pt`, `ar`, `da`, `nl`, `he`, `hi`, `ja`, `zh`, `vi`, `fi`, `no`, `sv`, `tr`. Для языка вне этого списка пакет отклоняет явный выбор Universal-3.5 Pro до загрузки аудио. Universal-2 выбран как стабильный общий default, пригодный для русского. Проверены [актуальные модели](https://www.assemblyai.com/docs/getting-started/models) и [языки Universal-3.5 Pro / Universal-2](https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro).

В AssemblyAI отправляется `speech_models: [model]`, без списка запасных моделей. Код языка передаётся как `language_code`; региональный дефис преобразуется в нижний регистр с подчёркиванием (`en-US` → `en_us`). Перед вычислением cache key CLI фиксирует эффективную запрошенную модель. Ответ хранит фактическую модель из `speech_model_used`; Deepgram — из `metadata.model_info.arch` либо `name`. Если API не вернул это поле, адаптер оставляет `model` отсутствующим и добавляет предупреждение. См. [Model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model) и [Submit API](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit).

`universal-3-pro` исключён: с 2 сентября 2026 года закреплённый выбор этой модели возвращает ошибку. Замена — `universal-3-5-pro`; см. [официальный changelog, 1 августа 2026](https://www.assemblyai.com/changelog/).

## Спикеры

Deepgram получает ровно `diarize=true` или `diarize=false` и `utterances` в том же режиме. Boolean `diarize` ещё принимается hosted API и использует diarizer v1, но уже помечен deprecated. Современный `diarize_model=latest` включает версию v2 для batch; сочетать его с `diarize` нельзя. Пакет использует boolean для соответствия явному контракту двух режимов. Если понадобится новая версия diarizer, изменение должно включать согласованное обновление API-контракта и параметров cache. Источники: [диаризация Deepgram](https://developers.deepgram.com/docs/diarization), [Pre-Recorded API](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).

AssemblyAI получает `speaker_labels: true/false`. При `true` и числовом `speakerCount` передаётся `speakers_expected`; при `auto` поле отсутствует. При выключенной диаризации подсказка числа не передаётся. Это подсказка алгоритму, а не гарантия правильного числа людей. Разделение не определяет имена или личности. Источники: [Speaker Diarization](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers), [ограничения параметров Submit API](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit).

Идентификаторы обоих API преобразуются в стабильные положительные целые. Deepgram 0 → 1, 1 → 2; AssemblyAI метки получают последовательные числа внутри результата. При `diarize=false` меток нет. Нормализованные тайминги измеряются в секундах; миллисекунды AssemblyAI делятся на 1000. Отсутствующие word timestamps не выдумываются, доступные тайминги фраз сохраняются. `raw` возвращается без изменения.

## Запросы, отмена и восстановление

Deepgram делает один POST `/v1/listen` с локальным FLAC. AssemblyAI делает один POST `/v2/upload`, затем один POST `/v2/transcript`. Адреса API фиксированы; redirects запрещены, чтобы не передать credentials другому серверу. API-ключ передаётся только в заголовке авторизации. [Upload API AssemblyAI](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload).

Платную попытку и lock сохраняет вызывающий оркестратор **до** вызова адаптера. Адаптеры не делают повторных POST. Ответ 4xx — окончательный отказ до распознавания, оплаты не было: ошибка помечена `definitive`, запрос записывается как `failed` и не блокирует файл, если задания AssemblyAI ещё нет. Коды: `PROVIDER_KEY_REJECTED` (401), `PROVIDER_NO_FUNDS` (402 или «balance is negative» в теле), `PROVIDER_FORBIDDEN` (403), `PROVIDER_RATE_LIMIT` (429), `PROVIDER_REJECTED` (прочие 4xx); тело ответа читается только для классификации и в сообщение не попадает. 5xx, отмена, сеть и timeout по-прежнему не дают права снова отправить аудио. После получения AssemblyAI ID обязательно вызывается и ожидается `onSubmitted({id, provider:'assemblyai'})`; callback должен завершить устойчивую запись ID до polling. При ошибке записи polling не начинается, ошибка содержит только безопасный `providerJob` для восстановления.

`resume({provider:'assemblyai',id,key,...})` выполняет только GET `/v2/transcript/{id}`, без чтения файла, upload и создания новой задачи. Для самого resume не нужны язык и модель; для сохранения меток нужно передать исходный `diarize`. Ошибки polling содержат `providerJob`. Deepgram не предоставляет аналогичный resume для синхронного POST. Тела сервисных ошибок, причины отмены и исходные исключения fetch/callback не включаются в сообщения.

Точная форма `error.providerJob`: `{id: string, provider: 'assemblyai'}`. Она присутствует при `PROVIDER_STATE_SAVE` после callback и при любой ошибке polling. Первый GET выполняется сразу после успешного callback; `queued` / `processing` вызывают ожидание интервала и следующий GET, `completed` возвращает нормализованный результат, `error` завершает polling с `PROVIDER_JOB_FAILED`. Неизвестный статус даёт `PROVIDER_RESPONSE`; сетевой GET не повторяется автоматически при ошибке. Общий timeout и внешняя отмена прерывают GET и ожидание между запросами.

## Разрешённые providerOptions

| Провайдер | Опция | Default | Ограничение |
| --- | --- | --- | --- |
| Оба | `timeoutMs` | см. ниже | Целое 1–2147483647, на каждый запрос включая чтение JSON; заменяет все расчётные значения |
| Deepgram | `smart_format` | `true` | Boolean |
| Deepgram | `utt_split` | Default API | Положительное конечное число секунд |
| AssemblyAI | `format_text` | `true` | Boolean |
| AssemblyAI | `pollTimeoutMs` | см. ниже | Целое 1–2147483647, на весь polling |
| AssemblyAI | `pollIntervalMs` | 3000 | Целое 1–2147483647 |

Без явных значений ожидание считается от записи (`requestTimeouts` в `lib/providers/index.mjs`). Отправка файла рассчитана на медленный канал около 0,4 Мбит/с (50 КБ/с). Deepgram: время отправки плюс 11 минут — сервис сам обрывает обработку дольше 10 минут ответом 504 ([Pre-recorded Audio](https://developers.deepgram.com/docs/pre-recorded-audio)), и клиент не должен сдаться раньше: оборванный запрос становится неопределённым. AssemblyAI: загрузка — 180 с плюс время отправки, создание задания и каждый GET — 180 с, весь polling — не меньше 6 минут и не меньше половины длительности записи. Если polling истёк, ID сохранён и задание продолжает `resume`.

Поля endpoint, headers, model, language, speaker_labels, diarize, speech_models, callback и произвольные API-параметры через `providerOptions` запрещены. Пунктуация включена явно; для AssemblyAI она нужна диаризации. Параметры API сверены по указанным reference pages. Внешний `signal` объединяется с сетевым timeout; отмена прерывает также ожидание между GET.

`timeoutMs`, `pollTimeoutMs` и `pollIntervalMs` управляют ожиданием, не меняют распознавание и должны исключаться из cache/request key. Иначе изменение timeout могло бы обойти запрет повторной оплаты. Остальные разрешённые опции влияют на результат и входят в ключ.

## Происхождение

Алгоритмы загрузки, запросов и нормализации адаптированы из исходного проекта `ИИ_монтаж/lib/transcription/deepgram.mjs` и `ИИ_монтаж/lib/transcription/assemblyai.mjs`, которые ссылаются на адаптеры Audio-Transcribator. Исходники прочитаны без изменения. Личные пути, настройки, ключи, медиа и результаты не переносились. Добавлены явные режимы, современный pinned список моделей, безопасные ошибки, внедрение сети, отмена и отдельный resume. Сведения о лицензии здесь не выдумываются.
