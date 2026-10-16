# Установка из командной строки для Windows: находит Node.js 22+ (или ставит его через winget) и запускает cli.mjs install.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$forwardArgs = @($args)
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$cliPath = Join-Path $scriptRoot 'skills\transcribe-media\scripts\cli.mjs'
. (Join-Path $scriptRoot 'skills\transcribe-media\scripts\node-bootstrap.ps1')
$allowInstall = $forwardArgs -contains '--allow-install'
$planOnly = ($forwardArgs -contains '--plan') -or ($forwardArgs -contains '--dry-run')
$userData = if ($env:TRANSCRIBE_MEDIA_DATA_HOME) { [IO.Path]::GetFullPath($env:TRANSCRIBE_MEDIA_DATA_HOME) } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'transcribe-media' }
$nodeLocator = Join-Path $userData 'tools\node-path.txt'
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
    if ($nodeReady -and $nodePath -ne (Get-PathNode)) { $forwardArgs += @('--node', $nodePath) }
}
if (-not $nodeReady) {
    Show-NodePlan
    if ($planOnly) { exit 0 }
    if (-not $allowInstall) { throw 'Нужен Node.js 22 или новее. Ничего не установлено. Передайте --allow-install, чтобы установить его через winget, или укажите --node.' }
    $nodePath = Install-NodeWithWinget $nodeLocator
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
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw "Не найден cli.mjs: $cliPath" }
& $nodePath $cliPath install @forwardArgs
exit $LASTEXITCODE
