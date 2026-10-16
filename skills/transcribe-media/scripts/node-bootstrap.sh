# Поиск Node.js 22+ и его установка на macOS через Homebrew. Подключается из start.sh и install.sh командой «.».
# В личную папку Node.js на macOS не скачивается; Linux пока использует прежнюю загрузку архива.

node_ok() {
  [ -n "${1:-}" ] || return 1
  version=$("$1" --version 2>/dev/null || true)
  major=${version#v}; major=${major%%.*}
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge 22 ]
}

# Приложения, запущенные из Dock или Finder, не видят PATH терминала. Homebrew, MacPorts и установщик Node.js
# кладут node в известные папки, а прежние версии мастера записывали путь в node-path.txt.
find_installed_node() {
  found_node=''
  candidates=$(command -v node 2>/dev/null || true)
  if [ -n "${1:-}" ] && [ -f "$1" ]; then IFS= read -r locator_node < "$1" || true; candidates="$candidates
${locator_node:-}"; fi
  candidates="$candidates
${HOMEBREW_PREFIX:+$HOMEBREW_PREFIX/bin/node}
/opt/homebrew/bin/node
/usr/local/bin/node
/opt/local/bin/node"
  saved_ifs=$IFS; IFS='
'
  for candidate in $candidates; do
    IFS=$saved_ifs
    if [ -n "$candidate" ] && node_ok "$candidate"; then found_node=$candidate; return 0; fi
  done
  IFS=$saved_ifs
  return 1
}

find_brew() {
  brew_path=$(command -v brew 2>/dev/null || true)
  for candidate in ${HOMEBREW_PREFIX:+"$HOMEBREW_PREFIX/bin/brew"} /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -z "$brew_path" ] && [ -x "$candidate" ]; then brew_path=$candidate; fi
  done
  [ -n "$brew_path" ]
}

show_mac_node_plan() {
  if find_brew; then
    echo 'План установки Node.js: brew install node — через Homebrew.'
  else
    echo 'Нужен Node.js 22 или новее. Homebrew не найден: установите Homebrew по инструкции с https://brew.sh (нужен пароль администратора) или Node.js LTS с https://nodejs.org/ (установщик .pkg), затем запустите установку снова.'
  fi
}

install_node_with_brew() {
  if ! find_brew; then echo 'Нет Homebrew. Установите его с https://brew.sh и запустите установку снова.' >&2; return 1; fi
  NONINTERACTIVE=1 "$brew_path" install node || true
  if ! find_installed_node "${1:-}"; then echo 'Node.js не установлен через Homebrew. Выполните в Терминале: brew install node — и запустите установку снова.' >&2; return 1; fi
}
