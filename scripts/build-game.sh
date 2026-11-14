#!/usr/bin/env bash
# Export the Godot runtime to the web and drop it where the studio serves it.
# Only needed when GDScript/engine config changes, not for content edits.
set -euo pipefail
cd "$(dirname "$0")/.."

GODOT="${GODOT:-godot}"
OUT="$PWD/apps/studio/public/game"

if ! command -v "$GODOT" >/dev/null; then
  echo "Godot 4.7 not found. Install it or set GODOT=/path/to/godot." >&2
  exit 1
fi

mkdir -p "$OUT"
"$GODOT" --headless --path game --import
"$GODOT" --headless --path game --export-release Web "$OUT/index.html"
echo "Exported runtime to $OUT"
