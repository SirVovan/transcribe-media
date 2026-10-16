#!/bin/sh
# Запускатель из корня пакета: передаёт работу запускателю в папке скилла.
set -eu
exec sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/skills/transcribe-media/scripts/start.sh" "$@"
