# Поиск Node.js 22+ и его установка способом разработчика: официальный установщик Node.js LTS через winget.
# Подключается из start.ps1 и install.ps1. В личную папку Node.js не скачивается.
$script:NodeWingetId = 'OpenJS.NodeJS.LTS'
$script:AppInstallerUrl = 'https://apps.microsoft.com/detail/9NBLGGH4NNS1'

function Test-NodeCandidate([string]$candidate) {
    if (-not $candidate) { return $false }
    try {
        $version = & $candidate --version 2>$null
        return ($LASTEXITCODE -eq 0) -and ("$version" -match '^v(\d+)\.') -and ([int]$Matches[1] -ge 22)
    } catch { return $false }
}

function Get-PathNode {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

# Node.js может быть установлен, но не виден в PATH этого окна: установщик Node.js кладёт его в Program Files\nodejs,
# winget — ссылку в WinGet\Links, прежние версии мастера записывали путь в node-path.txt.
function Find-InstalledNode([string]$locator) {
    $candidates = @(Get-PathNode)
    if ($locator -and (Test-Path -LiteralPath $locator -PathType Leaf)) { $candidates += (Get-Content -LiteralPath $locator -Encoding UTF8 -Raw).Trim() }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) { if ($root) { $candidates += Join-Path $root 'nodejs\node.exe' } }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\node.exe' }
    foreach ($candidate in $candidates) { if ($candidate -and (Test-NodeCandidate $candidate)) { return $candidate } }
    return $null
}

function Get-Winget {
    $command = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($env:LOCALAPPDATA) {
        $path = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

function Show-NodePlan {
    if (Get-Winget) { Write-Output "План установки Node.js: winget install --id $NodeWingetId — официальный установщик Node.js LTS с nodejs.org. Windows может попросить разрешение на изменения: нажмите «Да»." }
    else { Write-Output "Нужен Node.js 22 или новее. На компьютере нет winget: установите «Установщик приложений» из Microsoft Store ($AppInstallerUrl) или Node.js LTS с https://nodejs.org/ и запустите установку снова." }
}

function Install-NodeWithWinget([string]$locator) {
    $winget = Get-Winget
    if (-not $winget) { throw "Нет winget. Установите «Установщик приложений» из Microsoft Store: $AppInstallerUrl" }
    & $winget install --id $NodeWingetId --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    $code = [int]$LASTEXITCODE
    $node = Find-InstalledNode $locator
    if (-not $node) { throw ('Node.js не установлен: winget завершился с кодом 0x{0:X8}. Если Windows спрашивала разрешение на изменения, повторите установку и нажмите «Да».' -f $code) }
    return $node
}
