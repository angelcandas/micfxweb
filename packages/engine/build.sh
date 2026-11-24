#!/usr/bin/env bash
# Builds engine.wasm: the desktop app's DSP (extern/local-mic-effects/src/dsp, unchanged) plus
# the LiveEngine wrapper, for WebAssembly with Emscripten (emcc on the PATH).
#
# The wasm is standalone (no Emscripten JS glue) and uses no threads, so the AudioWorklet can
# instantiate it itself and the site needs no cross-origin isolation. Its few WASI imports are
# stubbed by src/engine.ts.
#
# Parameters.cpp and Presets.cpp (the parameter list and factory presets) compile unchanged
# against shim/juce_audio_processors, a small stand-in for the JUCE module that can't build here.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
desktop="$root/extern/local-mic-effects"
out="$here/dist"
work="$here/build"

[ -d "$desktop/libs/JUCE/modules" ] || { echo "Missing the desktop core: run 'pnpm deps' first." >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not found: install and activate the Emscripten SDK." >&2; exit 1; }

# A patched copy of the JUCE modules the DSP needs (the submodule stays clean).
juce="$work/juce"
stamp="$work/juce.stamp"
want="$(git -C "$desktop/libs/JUCE" rev-parse HEAD) $(sha1sum "$root/patches/juce-wasm.patch" | cut -c1-40)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  rm -rf "$juce" && mkdir -p "$juce"
  for m in juce_core juce_audio_basics juce_audio_formats juce_dsp; do cp -R "$desktop/libs/JUCE/modules/$m" "$juce/"; done
  (cd "$juce" && patch -p1 --binary --quiet < "$root/patches/juce-wasm.patch")
  echo "$want" > "$stamp"
fi

flags=(
  -std=c++20 -O2 -msimd128
  -I"$juce" -I"$here/shim" -I"$desktop/src" -I"$desktop/src/dsp" -I"$desktop/src/analysis"
  -DNDEBUG=1 -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -DJUCE_STANDALONE_APPLICATION=0
  -DJUCE_MODULE_AVAILABLE_juce_core=1 -DJUCE_MODULE_AVAILABLE_juce_audio_basics=1
  -DJUCE_MODULE_AVAILABLE_juce_audio_formats=1 -DJUCE_MODULE_AVAILABLE_juce_dsp=1
  -DJUCE_USE_CURL=0 -DJUCE_WEB_BROWSER=0 -DJUCE_USE_FLAC=0 -DJUCE_USE_OGGVORBIS=0
  -DJUCE_USE_MP3AUDIOFORMAT=0 -DJUCE_USE_LAME_AUDIO_FORMAT=0 -DJUCE_USE_WINDOWS_MEDIA_FORMAT=0
)

mkdir -p "$work/obj" "$out"
sources=(
  "$here/cpp/juce_modules.cpp"
  "$here/cpp/juce_wasm_stubs.cpp"
  "$here/cpp/LiveEngine.cpp"
  "$here/cpp/api.cpp"
  "$desktop/src/Parameters.cpp"
  "$desktop/src/Presets.cpp"
  "$desktop/src/analysis/Chords.cpp"
  "$desktop/src/analysis/Key.cpp"
)
objects=()
for src in "${sources[@]}"; do
  obj="$work/obj/$(basename "$src" .cpp).o"
  # JUCE is the slow one: rebuild it only when the patched copy changed.
  if [ "$src" != "$here/cpp/juce_modules.cpp" ] || [ ! -f "$obj" ] || [ "$stamp" -nt "$obj" ]; then
    echo "  compile $(basename "$src")"
    emcc "${flags[@]}" -c "$src" -o "$obj"
  fi
  objects+=("$obj")
done

em++ -O2 -msimd128 ${MICFX_LDFLAGS:-} "${objects[@]}" -o "$out/engine.wasm" \
  -sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_micfx_text,_micfx_result,_micfx_parameter_info,_micfx_presets,_micfx_load_preset,_micfx_status,_micfx_create,_micfx_destroy,_micfx_input,_micfx_output,_micfx_process,_micfx_set_value,_micfx_get_value,_micfx_reset_values,_micfx_value_info,_micfx_set_order,_micfx_get_order,_micfx_meters,_micfx_detect_key

echo "Built $(du -h "$out/engine.wasm" | cut -f1) $out/engine.wasm"
