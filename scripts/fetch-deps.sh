#!/usr/bin/env bash
# Fetches the desktop repo (the shared audio core) and the JUCE it pins.
# Only JUCE is needed from the desktop repo's own submodules, so the large ones
# (demucs.cpp, eigen) are left out until a build needs them.
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init extern/local-mic-effects
git -C extern/local-mic-effects submodule update --init --depth 1 libs/JUCE
echo "Desktop core: $(git -C extern/local-mic-effects log --oneline -1)"
