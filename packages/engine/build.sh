#!/usr/bin/env bash
# Builds engine.wasm: the desktop app's DSP (extern/local-mic-effects/src/dsp, unchanged) plus
# the LiveEngine wrapper, for WebAssembly with Emscripten (emcc on the PATH). And analysis.wasm:
# the desktop's measuring and planning code (src/analysis, the sound check's plan), for Web
# Workers, built with juce_events and juce_data_structures (patched: a message queue the page
# runs) and the fuller part of the juce_audio_processors shim.
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
  for m in juce_core juce_audio_basics juce_audio_formats juce_dsp juce_events juce_data_structures; do cp -R "$desktop/libs/JUCE/modules/$m" "$juce/"; done
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

studio_flags=("${flags[@]}" -DJUCE_MODULE_AVAILABLE_juce_events=1 -DJUCE_MODULE_AVAILABLE_juce_data_structures=1)

mkdir -p "$work/obj" "$work/obj-studio" "$out"

# compile <dir> <flags-array-name> <sources...>: prints the objects. JUCE units are slow:
# rebuilt only when the patched copy changed.
compile() {
  local dir="$1" flagsName="$2"; shift 2
  local -n useFlags="$flagsName"
  for src in "$@"; do
    local obj="$dir/$(basename "$src" .cpp).o"
    if [[ "$src" != */juce_modules.cpp && "$src" != */juce_studio_modules.cpp ]] || [ ! -f "$obj" ] || [ "$stamp" -nt "$obj" ]; then
      echo "  compile $(basename "$src")" >&2
      emcc "${useFlags[@]}" -c "$src" -o "$obj"
    fi
    echo "$obj"
  done
}

link() {
  local target="$1" exports="$2" stack="$3"; shift 3
  em++ -O2 -msimd128 ${MICFX_LDFLAGS:-} "$@" -o "$out/$target" -sSTACK_SIZE="$stack" \
    -sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS="$exports"
  echo "Built $(du -h "$out/$target" | cut -f1) $out/$target"
}

mapfile -t engine_objects < <(compile "$work/obj" flags \
  "$here/cpp/juce_modules.cpp" "$here/cpp/juce_wasm_stubs.cpp" "$here/cpp/LiveEngine.cpp" "$here/cpp/api.cpp" \
  "$desktop/src/Parameters.cpp" "$desktop/src/Presets.cpp" "$desktop/src/analysis/Chords.cpp" "$desktop/src/analysis/Key.cpp" \
  "$desktop/src/Looper.cpp")
link engine.wasm _malloc,_free,_micfx_text,_micfx_result,_micfx_parameter_info,_micfx_presets,_micfx_load_preset,_micfx_status,_micfx_create,_micfx_destroy,_micfx_input,_micfx_output,_micfx_process,_micfx_set_value,_micfx_get_value,_micfx_reset_values,_micfx_value_info,_micfx_set_order,_micfx_get_order,_micfx_meters,_micfx_detect_key,_micfx_looper_command,_micfx_looper_layer,_micfx_looper_settings,_micfx_looper_state,_micfx_looper_copy,_micfx_looper_copied,_micfx_offer_noise_profile,_micfx_pitch_enable,_micfx_set_timeline,_micfx_pitch_read,_micfx_pitch_readings 65536 "${engine_objects[@]}"

# The analysis code reaches the DAW engine in places the sound check never calls; the
# linker drops those, so only what the exports use is built in.
mapfile -t analysis_objects < <(compile "$work/obj-studio" studio_flags \
  "$here/cpp/juce_studio_modules.cpp" "$here/cpp/analysis_api.cpp" \
  "$desktop/src/SoundCheck.cpp" "$desktop/src/Scenes.cpp" "$desktop/src/analysis/"*.cpp)
# The analysis keeps big frames on the stack: 1 MB of it (the engine's default 64 KB is plenty there).
link analysis.wasm _malloc,_free,_micfx_result,_micfx_styles,_micfx_sound_check,_micfx_noise_profile,_micfx_find_melody,_micfx_score_song,_micfx_score_frames,_micfx_score_restart,_micfx_score_time,_micfx_score_changes,_micfx_score_report 1048576 \
  "$work/obj/juce_modules.o" "$work/obj/juce_wasm_stubs.o" "${analysis_objects[@]}"

# stems.wasm: the stem splitter network (demucs.cpp, MIT, on Eigen, MPL 2.0: the desktop's
# libs/). Its weights are downloaded by the page, not built in.
demucs="$desktop/libs/demucs.cpp"
if [ -d "$demucs/src" ] && [ -d "$desktop/libs/eigen/Eigen" ]; then
  stems_flags=(-std=c++17 -O3 -msimd128 -msse4.2 -ffast-math -fno-exceptions -DNDEBUG -I"$desktop/libs/eigen" -I"$demucs/src" -I"$demucs/src_wasm")
  mkdir -p "$work/obj-stems"
  stems_objects=()
  for src in "$demucs/src/"*.cpp "$here/cpp/demucs_api.cpp"; do
    obj="$work/obj-stems/$(basename "$src" .cpp).o"
    if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
      echo "  compile $(basename "$src")" >&2
      em++ "${stems_flags[@]}" -c "$src" -o "$obj"
    fi
    stems_objects+=("$obj")
  done
  em++ -O3 -msimd128 "${stems_objects[@]}" -o "$out/stems.wasm" -sSTACK_SIZE=5242880 -sSTANDALONE_WASM=1 --no-entry \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_malloc,_free,_micfx_stems_load,_micfx_stems_separate
  echo "Built $(du -h "$out/stems.wasm" | cut -f1) $out/stems.wasm"
else
  echo "Missing libs/demucs.cpp or libs/eigen in the desktop core: run 'pnpm deps' first." >&2
  exit 1
fi
