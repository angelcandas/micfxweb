#!/usr/bin/env bash
# Fetches the desktop repo (the shared audio core) and the JUCE it pins.
# From the desktop repo's own submodules: JUCE, and demucs.cpp with Eigen for the stem
# splitter (stems.wasm). Shallow, so it stays quick.
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init extern/local-mic-effects
git -C extern/local-mic-effects submodule update --init --depth 1 libs/JUCE libs/demucs.cpp libs/eigen
echo "Desktop core: $(git -C extern/local-mic-effects log --oneline -1)"
