# Запускатель для Windows: находит Node.js 22+ (или ставит его через winget) и открывает мастер установки.
# Лежит в папке скилла, чтобы работать и после /plugin install или npx skills add, где корня пакета нет.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$forwardArgs = @($args)
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$cliPath = Join-Path $scriptRoot 'installer.mjs'
. (Join-Path $scriptRoot 'node-bootstrap.ps1')
$planOnly = ($forwardArgs -contains '--plan') -or ($forwardArgs -contains '--dry-run')
$chatMode = $forwardArgs -contains '--chat'
$allowCheck = $forwardArgs -contains '--allow-check'
$allowNodeInstall = $forwardArgs -contains '--allow-node-install'
if ($chatMode) { $forwardArgs = @($forwardArgs | Where-Object { $_ -notin @('--chat','--plan','--dry-run','--allow-check','--allow-node-install') }) }
if ($chatMode -and ($planOnly -or -not $allowCheck)) { Show-NodePlan; Write-Output 'Node.js ещё не проверялся. После согласия повторите с --chat --allow-check.'; exit 0 }
$userData = if ($env:TRANSCRIBE_MEDIA_DATA_HOME) { [IO.Path]::GetFullPath($env:TRANSCRIBE_MEDIA_DATA_HOME) } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'transcribe-media' }
$nodeLocator = Join-Path $userData 'tools\node-path.txt'
$panelDirectory = Join-Path ([IO.Path]::GetTempPath()) ('transcribe-start-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $panelDirectory | Out-Null
$env:TRANSCRIBE_BOOTSTRAP_HANDOFF = Join-Path $panelDirectory 'panel.html'
$env:TRANSCRIBE_BOOTSTRAP_INSTALLED = '0'
function Update-Panel([string]$operation) {
    $text = [Net.WebUtility]::HtmlEncode($operation)
    $channelHint = if ($chatMode) { 'На вопросы отвечайте в чате.' } else { 'Ответьте в терминале.' }
    $html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Первый запуск</title><style>body{font:18px system-ui;max-width:850px;margin:40px auto}</style><h1>Установка transcribe-media</h1><ol><li>Поиск Node.js на компьютере</li><li>Согласие на установку Node.js, если его нет</li><li>Установка Node.js через winget</li><li>Запуск мастера установки</li></ol><h2>' + $text + '</h2><ul><li>Node.js: ожидает проверки</li><li>FFmpeg: Наличие ещё не проверено</li><li>ffprobe: Наличие ещё не проверено</li><li>yt-dlp: Наличие ещё не проверено</li></ul><p>' + [Net.WebUtility]::HtmlEncode($channelHint) + '</p></html>'
    [IO.File]::WriteAllText($env:TRANSCRIBE_BOOTSTRAP_HANDOFF,$html,[Text.UTF8Encoding]::new($false))
}
trap { Update-Panel ('Ошибка первого запуска. Подробности — в терминале.'); Write-Output $_; exit 1 }
Update-Panel 'Ожидание разрешения проверить Node.js'
if (-not $chatMode) {
    Write-Output ('Панель первого запуска: ' + $env:TRANSCRIBE_BOOTSTRAP_HANDOFF)
    try { Start-Process $env:TRANSCRIBE_BOOTSTRAP_HANDOFF } catch { Write-Output 'Откройте файл панели вручную. Терминал продолжает работу.' }
    $answer = Read-Host 'Разрешить проверить установленный Node.js? (да/нет)'
    if ($answer -notmatch '^(да|yes|y|1)$') { Update-Panel 'Отменено. Ничего не установлено.'; exit 0 }
}
$explicitNode = $forwardArgs -contains '--node'
$nodePath = $null
for ($i = 0; $i -lt $forwardArgs.Count; $i++) {
    if ($forwardArgs[$i] -eq '--node') {
        if ($i + 1 -ge $forwardArgs.Count) { throw 'После --node укажите путь к node.exe.' }
        $nodePath = $forwardArgs[$i + 1]
    }
}
if ($explicitNode) { $nodeReady = Test-NodeCandidate $nodePath }
else {
    $nodePath = Find-InstalledNode $nodeLocator
    $nodeReady = [bool]$nodePath
    # Node.js найден вне PATH этого окна: передаём путь мастеру явно.
    if ($nodeReady -and $nodePath -ne (Get-PathNode)) { $forwardArgs += @('--node', $nodePath) }
}
if (-not $nodeReady) {
    Show-NodePlan
    if ($planOnly) { exit 0 }
    if (-not (Get-Winget)) { Update-Panel 'Нужен Node.js 22 или новее; winget не найден. Подробности — в терминале.'; exit 2 }
    if ($chatMode -and -not $allowNodeInstall) { Update-Panel 'Требуется Node.js. План показан; установка ожидает согласия в чате.'; Write-Output 'node-required: после согласия на этот план повторите с --chat --allow-check --allow-node-install.'; exit 2 }
    Update-Panel 'Требуется Node.js: установка через winget. Ожидание согласия.'
    if (-not $chatMode) {
        $answer = Read-Host 'Разрешить установить Node.js LTS через winget? (да/нет)'
        if ($answer -notmatch '^(да|yes|y|1)$') { Update-Panel 'Установка отклонена. Установите Node.js 22+ с https://nodejs.org/ и повторите запуск.'; exit 0 }
    }
    Update-Panel 'Устанавливается Node.js через winget. Если Windows попросит разрешение на изменения, нажмите «Да».'
    $nodePath = Install-NodeWithWinget $nodeLocator
    $env:TRANSCRIBE_BOOTSTRAP_INSTALLED = '1'
    if ($explicitNode) {
        $remainingArgs = @()
        for ($i = 0; $i -lt $forwardArgs.Count; $i++) {
            if ($forwardArgs[$i] -eq '--node') { $i++; continue }
            $remainingArgs += $forwardArgs[$i]
        }
        $forwardArgs = $remainingArgs
    }
    $forwardArgs += @('--node', $nodePath)
}
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw "Не найден мастер установки: $cliPath" }
Update-Panel 'Node.js готов. Запускается мастер установки; ссылка появится здесь.'
# В чате мастер работает отдельным фоновым процессом: команда сразу возвращает адрес панели и не держит чат.
if ($chatMode) { & $nodePath $cliPath serve --detach --open @forwardArgs } else { & $nodePath $cliPath start @forwardArgs }
exit $LASTEXITCODE
