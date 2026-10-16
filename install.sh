#!/bin/sh
# Установка из командной строки для macOS/Linux: находит Node.js 22+ (на macOS при необходимости ставит его
# через Homebrew) и запускает cli.mjs install. На реальном macOS не проверялся.
set -eu
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cli_path="$script_root/skills/transcribe-media/scripts/cli.mjs"
. "$script_root/skills/transcribe-media/scripts/node-bootstrap.sh"
allow_install=false
plan_only=false
node_path=''
next_node=false
explicit_node=false
for argument in "$@"; do
  if "$next_node"; then node_path=$argument; next_node=false; continue; fi
  case "$argument" in
    --allow-install) allow_install=true ;;
    --plan|--dry-run) plan_only=true ;;
    --node) next_node=true; explicit_node=true ;;
  esac
done
if "$next_node"; then echo 'После --node укажите путь к node.' >&2; exit 1; fi
node_ready=false
case "$(uname -s)" in Darwin) default_data="$HOME/Library/Application Support/transcribe-media" ;; *) default_data="${XDG_DATA_HOME:-$HOME/.local/share}/transcribe-media" ;; esac
tool_root="${TRANSCRIBE_MEDIA_DATA_HOME:-$default_data}/tools"
node_locator="$tool_root/node-path.txt"
if "$explicit_node"; then
  if node_ok "$node_path"; then node_ready=true; fi
elif find_installed_node "$node_locator"; then
  node_path=$found_node; node_ready=true
  if [ "$node_path" != "$(command -v node 2>/dev/null || true)" ]; then set -- "$@" --node "$node_path"; fi
fi
if ! "$node_ready" && [ "$(uname -s)" = Darwin ]; then
  show_mac_node_plan
  if "$plan_only"; then exit 0; fi
  if ! "$allow_install"; then echo 'Нужен Node.js 22 или новее. Ничего не установлено. Передайте --allow-install, чтобы установить его через Homebrew, или укажите --node.' >&2; exit 1; fi
  install_node_with_brew "$node_locator"
  node_path=$found_node; node_ready=true
  if "$explicit_node"; then
    remaining=$#
    while [ "$remaining" -gt 0 ]; do
      argument=$1; shift; remaining=$((remaining - 1))
      if [ "$argument" = --node ]; then shift; remaining=$((remaining - 1)); else set -- "$@" "$argument"; fi
    done
  fi
  set -- "$@" --node "$node_path"
fi
if ! "$node_ready"; then
  case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) echo 'Supply Node >=22 for this OS.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) echo 'Supply Node >=22 for this architecture.' >&2; exit 1 ;; esac
  node_release=v22.23.3
  asset="node-$node_release-$node_os-$node_arch.tar.xz"
  base_url="https://nodejs.org/dist/$node_release"
  printf '%s\n' "Node bootstrap plan: $base_url/$asset; verify SHA-256 using $base_url/SHASUMS256.txt; extract bin/node into user data; PATH remains unchanged."
  if "$plan_only"; then exit 0; fi
  if ! "$allow_install"; then echo 'Node >=22 is required. Nothing was downloaded. Pass --allow-install or supply --node.' >&2; exit 1; fi
  # No package manager, sudo, or shell piping from the network.
  if ! command -v curl >/dev/null 2>&1; then echo 'curl required for HTTPS download; install it explicitly or supply --node.' >&2; exit 1; fi
  if ! command -v tar >/dev/null 2>&1; then echo 'tar required; install it explicitly or supply --node.' >&2; exit 1; fi
  if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum; elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum; else echo 'sha256sum/shasum required; supply --node.' >&2; exit 1; fi
  cursor=$tool_root
  while [ "$cursor" != / ] && [ -n "$cursor" ]; do
    if [ -L "$cursor" ]; then echo 'Bootstrap path contains a symlink.' >&2; exit 1; fi
    cursor=$(dirname -- "$cursor")
  done
  mkdir -p -- "$tool_root"
  stage=$(mktemp -d "$tool_root/node-bootstrap.XXXXXXXX")
  curl --proto '=https' --proto-redir '=https' --fail --location --output "$stage/$asset" "$base_url/$asset"
  curl --proto '=https' --proto-redir '=https' --fail --location --output "$stage/SHASUMS256.txt" "$base_url/SHASUMS256.txt"
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1}' "$stage/SHASUMS256.txt")
  if [ "$hash_tool" = sha256sum ]; then actual=$(sha256sum "$stage/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$stage/$asset" | awk '{print $1}'); fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo 'Node archive SHA-256 mismatch.' >&2; exit 1; fi
  member="node-$node_release-$node_os-$node_arch/bin/node"
  listing=$(tar -tvf "$stage/$asset" "$member")
  case "$listing" in -*) ;; *) echo 'Node executable missing or unsafe in archive.' >&2; exit 1 ;; esac
  tar -xf "$stage/$asset" -C "$stage" "$member"
  node_path="$stage/$member"
  version=$("$node_path" --version)
  major=${version#v}; major=${major%%.*}
  case "$major" in ''|*[!0-9]*) echo 'Bootstrapped Node failed validation.' >&2; exit 1 ;; *) [ "$major" -ge 22 ] || exit 1 ;; esac
  if [ -L "$node_locator" ]; then echo 'Node locator is a symlink.' >&2; exit 1; fi
  printf '%s\n' "$node_path" > "$node_locator"
  set -- "$@" --node "$node_path"
fi
if [ ! -f "$cli_path" ]; then printf 'Portable CLI missing: %s\n' "$cli_path" >&2; exit 1; fi
exec "$node_path" "$cli_path" install "$@"
