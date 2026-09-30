#!/usr/bin/env bash
# Install this skill folder for Codex and/or OpenCode.
#
# Usage: bash install.sh [--target codex|opencode|all] [--symlink]
#   codex     -> ${CODEX_HOME:-$HOME/.codex}/skills/bcap
#   opencode  -> ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/bcap
#   all       -> both
# Default target: codex. Copy is self-contained (includes node_modules);
# --symlink links the target to this folder instead.
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="copy"
target="codex"

while [ $# -gt 0 ]; do
  case "$1" in
    --symlink) mode="symlink" ;;
    --target) target="${2:?--target needs codex|opencode|all}"; shift ;;
    --target=*) target="${1#--target=}" ;;
    codex|opencode|all) target="$1" ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$target" in
  codex|opencode|all) ;;
  *) echo "install.sh: unknown target '$target' (use codex, opencode or all)" >&2; exit 2 ;;
esac

install_one() {
  local name="$1" dest="$2"
  if [ "$mode" = "symlink" ]; then
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$skill_dir" "$dest"
    echo "bcap installed for $name (symlink) -> $dest"
    return
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$skill_dir/SKILL.md" "$skill_dir/README.md" "$skill_dir/scripts" "$skill_dir/sites" "$skill_dir/references" "$skill_dir/agents" "$skill_dir/package.json" "$dest/"
  (cd "$dest" && npm install --omit=dev --no-audit --no-fund >/dev/null)
  echo "bcap installed for $name (copy) -> $dest"
}

if [ "$target" = "codex" ] || [ "$target" = "all" ]; then
  install_one codex "${CODEX_HOME:-$HOME/.codex}/skills/bcap"
fi
if [ "$target" = "opencode" ] || [ "$target" = "all" ]; then
  install_one opencode "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/bcap"
fi
