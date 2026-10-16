# Запускатель из корня пакета (его вызывает Установить.cmd): передаёт работу запускателю в папке скилла.
& (Join-Path $PSScriptRoot 'skills\transcribe-media\scripts\start.ps1') @args
exit $LASTEXITCODE
