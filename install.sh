#!/usr/bin/env bash
# Install this skill folder into ~/.codex/skills/bcap.
# Default: copy (self-contained, includes node_modules). Use --symlink to link to this folder instead.
set -euo pipefail
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${CODEX_HOME:-$HOME/.codex}/skills/bcap"
mkdir -p "$(dirname "$target")"
if [ "${1:-}" = "--symlink" ]; then
  ln -sfn "$skill_dir" "$target"
  echo "bcap installed (symlink) -> $target"
  exit 0
fi
rm -rf "$target"
mkdir -p "$target"
cp -R "$skill_dir/SKILL.md" "$skill_dir/README.md" "$skill_dir/scripts" "$skill_dir/sites" "$skill_dir/references" "$skill_dir/agents" "$skill_dir/package.json" "$target/"
(cd "$target" && npm install --omit=dev --no-audit --no-fund >/dev/null)
echo "bcap installed (copy) -> $target"
