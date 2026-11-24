#!/usr/bin/env bash
# The source of the deployed app as one .zip (the AGPLv3 asks that its users can get it):
# this repo as built, plus the desktop app's code it compiles (src/, ui/). JUCE, demucs.cpp
# and Eigen are named with the exact versions used (they're public, and large).
# Usage: scripts/source-archive.sh <out.zip>
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(realpath -m "$1")"
desktop=extern/local-mic-effects
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
root="$work/micfx-web-source"
mkdir -p "$root/$desktop"

git archive HEAD | tar -x -C "$root" --exclude='docs/pr-screenshots'
git -C "$desktop" archive HEAD -- src ui CMakeLists.txt LICENSE README.md | tar -x -C "$root/$desktop"
{
  echo "MicFX web apps: source code (GNU AGPLv3, see LICENSE)."
  echo
  echo "This repo:           $(git rev-parse HEAD)"
  echo "Desktop core:        $(git -C "$desktop" rev-parse HEAD) (src/ and ui/ are included under $desktop)"
  for lib in JUCE demucs.cpp eigen; do
    if [ -d "$desktop/libs/$lib/.git" ] || [ -f "$desktop/libs/$lib/.git" ]; then
      printf '%-20s %s %s\n' "$lib:" "$(git -C "$desktop/libs/$lib" rev-parse HEAD)" "$(git -C "$desktop" config --file .gitmodules "submodule.libs/$lib.url")"
    fi
  done
  echo
  echo "Build: scripts/fetch-deps.sh (fetches the libraries above), then pnpm install,"
  echo "pnpm --filter @micfx/engine build, pnpm build. See README.md."
} > "$root/SOURCES.txt"
rm -f "$out"
(cd "$work" && zip -qr "$out" micfx-web-source)
echo "Source archive: $(du -h "$out" | cut -f1) $out"
