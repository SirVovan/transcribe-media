#!/bin/sh
# Запускатель для macOS/Linux: находит Node.js 22+ (на macOS при необходимости ставит его через Homebrew) и открывает мастер.
# На реальном macOS не проверялся. Лежит в папке скилла, чтобы работать и после /plugin install или npx skills add.
set -eu
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cli_path="$script_root/installer.mjs"
. "$script_root/node-bootstrap.sh"
is_mac=false
if [ "$(uname -s)" = Darwin ]; then is_mac=true; fi
allow_install=false
plan_only=false
node_path=''
next_node=false
explicit_node=false
chat_mode=false
allow_check=false
allow_node_install=false
for argument in "$@"; do
  if "$next_node"; then node_path=$argument; next_node=false; continue; fi
  case "$argument" in
    --chat) chat_mode=true ;;
    --allow-check) allow_check=true ;;
    --allow-node-install) allow_node_install=true ;;
    --allow-install) allow_install=true ;;
    --plan|--dry-run) plan_only=true ;;
    --node) next_node=true; explicit_node=true ;;
  esac
done
if "$chat_mode"; then
  remaining=$#
  while [ "$remaining" -gt 0 ]; do
    argument=$1; shift; remaining=$((remaining - 1))
    case "$argument" in --chat|--allow-check|--allow-node-install|--plan|--dry-run) ;; *) set -- "$@" "$argument" ;; esac
  done
fi
node_plan() {
  if "$is_mac"; then show_mac_node_plan; return 0; fi
  case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) echo 'Supply Node >=22 for this OS.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) echo 'Supply Node >=22 for this architecture.' >&2; exit 1 ;; esac
  node_release=v22.23.3
  asset="node-$node_release-$node_os-$node_arch.tar.xz"
  base_url="https://nodejs.org/dist/$node_release"
  printf '%s\n' "Node bootstrap plan: $base_url/$asset; verify SHA-256 using $base_url/SHASUMS256.txt; extract bin/node into user data; PATH remains unchanged."
}
if "$chat_mode" && { "$plan_only" || ! "$allow_check"; }; then
  node_plan
  echo 'Node.js ещё не проверялся. После согласия повторите с --chat --allow-check.'
  exit 0
fi
if "$next_node"; then echo 'После --node укажите путь к node.' >&2; exit 1; fi
node_ready=false
case "$(uname -s)" in Darwin) default_data="$HOME/Library/Application Support/transcribe-media" ;; *) default_data="${XDG_DATA_HOME:-$HOME/.local/share}/transcribe-media" ;; esac
data_root="${TRANSCRIBE_MEDIA_DATA_HOME:-$default_data}"
case "$data_root" in /*) ;; *) data_root="$(pwd -P)/$data_root" ;; esac
tool_root="$data_root/tools"
node_locator="$tool_root/node-path.txt"
panel_dir=$(mktemp -d "${TMPDIR:-/tmp}/transcribe-start.XXXXXXXX")
TRANSCRIBE_BOOTSTRAP_HANDOFF="$panel_dir/panel.html"
export TRANSCRIBE_BOOTSTRAP_HANDOFF
TRANSCRIBE_BOOTSTRAP_INSTALLED=0
export TRANSCRIBE_BOOTSTRAP_INSTALLED
panel() {
  channel_hint='Ответьте в терминале.'
  if "$chat_mode"; then channel_hint='На вопросы отвечайте в чате.'; fi
  printf '%s\n' '<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Первый запуск</title><style>body{font:18px system-ui;max-width:850px;margin:40px auto}</style><h1>Установка transcribe-media</h1><ol><li>Поиск Node.js на компьютере</li><li>Согласие на установку Node.js, если его нет</li><li>Установка Node.js</li><li>Запуск мастера установки</li></ol>' "<h2>$1</h2>" '<ul><li>Node.js: ожидает проверки</li><li>FFmpeg: Наличие ещё не проверено</li><li>ffprobe: Наличие ещё не проверено</li><li>yt-dlp: Наличие ещё не проверено</li></ul><p>' "$channel_hint</p></html>" > "$TRANSCRIBE_BOOTSTRAP_HANDOFF"
}
trap 'exit_status=$?; if [ "$exit_status" -ne 0 ]; then panel "Ошибка первого запуска. Проверьте сообщение в терминале; установите Node версии 22 или новее вручную и повторите запуск."; fi' 0
panel 'Ожидание разрешения проверить Node'
if ! "$chat_mode"; then
  printf 'Панель первого запуска: %s\n' "$TRANSCRIBE_BOOTSTRAP_HANDOFF"
  case "$(uname -s)" in Darwin) open "$TRANSCRIBE_BOOTSTRAP_HANDOFF" >/dev/null 2>&1 || true ;; *) if command -v xdg-open >/dev/null 2>&1; then xdg-open "$TRANSCRIBE_BOOTSTRAP_HANDOFF" >/dev/null 2>&1 || true; fi ;; esac
  printf 'Разрешить проверить установленный Node? (да/нет): '
  IFS= read -r answer || answer=нет
  case "$answer" in да|yes|y|1) ;; *) panel 'Отменено. Ничего не установлено.'; exit 0 ;; esac
fi
if "$explicit_node"; then
  if node_ok "$node_path"; then node_ready=true; fi
elif find_installed_node "$node_locator"; then
  node_path=$found_node; node_ready=true
  # Node.js найден вне PATH этого окна: передаём путь мастеру явно.
  if [ "$node_path" != "$(command -v node 2>/dev/null || true)" ]; then set -- "$@" --node "$node_path"; fi
fi
if ! "$node_ready"; then
  node_plan
  if "$plan_only"; then exit 0; fi
  if "$is_mac" && ! find_brew; then panel 'Нужен Node.js 22 или новее; Homebrew не найден. Подробности — в терминале.'; exit 2; fi
  if "$chat_mode" && ! "$allow_node_install"; then
    panel 'Требуется Node.js. План показан; установка ожидает согласия в чате.'
    echo 'node-required: после согласия на этот план повторите с --chat --allow-check --allow-node-install.'
    exit 2
  fi
  if "$is_mac"; then
  panel 'Требуется Node.js: установка через Homebrew. Ожидание согласия.'
  if ! "$chat_mode"; then
    printf 'Разрешить установить Node.js через Homebrew (brew install node)? (да/нет): '
    IFS= read -r answer || answer=нет
    case "$answer" in да|yes|y|1) ;; *) panel 'Установка отклонена. Установите Node.js 22+ с https://nodejs.org/ и повторите запуск.'; exit 0 ;; esac
  fi
  panel 'Устанавливается Node.js через Homebrew.'
  install_node_with_brew "$node_locator"
  node_path=$found_node
  TRANSCRIBE_BOOTSTRAP_INSTALLED=1
  if "$explicit_node"; then
    remaining=$#
    while [ "$remaining" -gt 0 ]; do
      argument=$1; shift; remaining=$((remaining - 1))
      if [ "$argument" = --node ]; then shift; remaining=$((remaining - 1)); else set -- "$@" "$argument"; fi
    done
  fi
  set -- "$@" --node "$node_path"
  else
  panel 'Требуется приватный Node. Адрес архива и SHA-256 показаны в терминале. Ожидание согласия.'
  if ! "$chat_mode"; then
    printf 'Разрешить эту загрузку и установку Node? (да/нет): '
    IFS= read -r answer || answer=нет
    case "$answer" in да|yes|y|1) ;; *) panel 'Загрузка отклонена. Установите Node >=22 вручную и повторите запуск.'; exit 0 ;; esac
  fi
  # No package manager, sudo, or shell piping from the network.
  if ! command -v curl >/dev/null 2>&1; then echo 'curl required for HTTPS download; install it explicitly or supply --node.' >&2; exit 1; fi
  if ! command -v tar >/dev/null 2>&1; then echo 'tar required; install it explicitly or supply --node.' >&2; exit 1; fi
  if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum; elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum; else echo 'sha256sum/shasum required; supply --node.' >&2; exit 1; fi
  cursor=$tool_root
  while [ "$cursor" != / ] && [ -n "$cursor" ]; do
    if [ -L "$cursor" ]; then echo 'Bootstrap path contains a symlink.' >&2; exit 1; fi
    parent=$(dirname -- "$cursor")
    [ "$parent" = "$cursor" ] && break
    cursor=$parent
  done
  mkdir -p -- "$tool_root"
  stage=$(mktemp -d "$tool_root/node-bootstrap.XXXXXXXX")
  panel 'Скачивается архив Node. Общий размер не измеряется.'
  curl --proto '=https' --proto-redir '=https' --fail --location --output "$stage/$asset" "$base_url/$asset"
  curl --proto '=https' --proto-redir '=https' --fail --location --output "$stage/SHASUMS256.txt" "$base_url/SHASUMS256.txt"
  panel 'Проверяется SHA-256 скачанного архива'
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1}' "$stage/SHASUMS256.txt")
  if [ "$hash_tool" = sha256sum ]; then actual=$(sha256sum "$stage/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$stage/$asset" | awk '{print $1}'); fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo 'Node archive SHA-256 mismatch.' >&2; exit 1; fi
  member="node-$node_release-$node_os-$node_arch/bin/node"
  listing=$(tar -tvf "$stage/$asset" "$member")
  case "$listing" in -*) ;; *) echo 'Node executable missing or unsafe in archive.' >&2; exit 1 ;; esac
  panel 'Извлекается приватный Node; глобальный PATH не меняется'
  tar -xf "$stage/$asset" -C "$stage" "$member"
  node_path="$stage/$member"
  version=$("$node_path" --version)
  major=${version#v}; major=${major%%.*}
  case "$major" in ''|*[!0-9]*) echo 'Bootstrapped Node failed validation.' >&2; exit 1 ;; *) [ "$major" -ge 22 ] || exit 1 ;; esac
  if [ -L "$node_locator" ]; then echo 'Node locator is a symlink.' >&2; exit 1; fi
  printf '%s\n' "$node_path" > "$node_locator"
  TRANSCRIBE_BOOTSTRAP_INSTALLED=1
  if "$explicit_node"; then
    remaining=$#
    while [ "$remaining" -gt 0 ]; do
      argument=$1; shift; remaining=$((remaining - 1))
      if [ "$argument" = --node ]; then shift; remaining=$((remaining - 1)); else set -- "$@" "$argument"; fi
    done
  fi
  set -- "$@" --node "$node_path"
  fi
fi
if [ ! -f "$cli_path" ]; then printf 'Не найден мастер установки: %s\n' "$cli_path" >&2; exit 1; fi
panel 'Node.js готов. Запускается мастер установки; ссылка появится здесь.'
# В чате мастер работает отдельным фоновым процессом: команда сразу возвращает адрес панели и не держит чат.
if "$chat_mode"; then exec "$node_path" "$cli_path" serve --detach --open "$@"; fi
exec "$node_path" "$cli_path" start "$@"
