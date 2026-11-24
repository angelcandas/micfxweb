#!/usr/bin/env bash
# Builds daw.js + daw.wasm: the desktop DAW (PluginProcessor in DAW mode, DawBridge, src/daw,
# src/analysis, the MicFX instruments, LAME) for a Web Worker, with threads.
#
# Unlike engine.wasm this build uses Emscripten's pthreads (the desktop's background jobs,
# Auto Mix, exports, key detection, run on real threads) and its JS glue, so the page that
# loads it must be cross-origin isolated (COOP/COEP headers; apps/daw/public/_headers). The
# audio runs on a thread of its own and hands blocks to the page's AudioWorklet through a
# ring in the shared wasm memory (cpp/daw/DawHost.cpp).
#
# juce_gui_basics and juce_audio_devices can't build here: shim-daw/ has the few names the
# DAW code uses from them (file choosers go to the page; windows are never shown).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
desktop="$root/extern/local-mic-effects"
out="$here/dist"
work="$here/build"

[ -d "$desktop/libs/JUCE/modules" ] || { echo "Missing the desktop core: run 'pnpm deps' first." >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not found: install and activate the Emscripten SDK." >&2; exit 1; }

juce="$work/juce-daw"
stamp="$work/juce-daw.stamp"
want="$(git -C "$desktop/libs/JUCE" rev-parse HEAD) $(sha1sum "$root/patches/juce-wasm.patch" | cut -c1-40)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  rm -rf "$juce" && mkdir -p "$juce"
  for m in juce_core juce_audio_basics juce_audio_formats juce_dsp juce_events juce_data_structures juce_cryptography juce_audio_devices; do cp -R "$desktop/libs/JUCE/modules/$m" "$juce/"; done
  (cd "$juce" && patch -p1 --binary --quiet < "$root/patches/juce-wasm.patch")
  echo "$want" > "$stamp"
fi

base=(
  -O2 -msimd128 -pthread
  -DNDEBUG=1 -DMICFX_WEB=1 -DMICFX_WEB_DAW=1
  -DJUCE_LITTLE_ENDIAN=1 # JUCE sets no byte order for WebAssembly (it is little-endian): without it, 16-bit WAVs decode as silence
)
flags=(
  -std=c++20 "${base[@]}"
  -I"$juce" -I"$here/shim-daw" -I"$here/shim" -I"$desktop/src" -I"$desktop/src/dsp" -I"$desktop/src/analysis"
  -I"$desktop/libs/lame/include"
  -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -DJUCE_STANDALONE_APPLICATION=1
  -DJUCE_MODULE_AVAILABLE_juce_core=1 -DJUCE_MODULE_AVAILABLE_juce_audio_basics=1
  -DJUCE_MODULE_AVAILABLE_juce_audio_formats=1 -DJUCE_MODULE_AVAILABLE_juce_dsp=1
  -DJUCE_MODULE_AVAILABLE_juce_events=1 -DJUCE_MODULE_AVAILABLE_juce_data_structures=1
  -DJUCE_MODULE_AVAILABLE_juce_audio_processors=1 -DJUCE_MODULE_AVAILABLE_juce_gui_basics=1
  -DJUCE_MODULE_AVAILABLE_juce_cryptography=1 -DJUCE_MODULE_AVAILABLE_juce_audio_devices=1
  -DJUCE_USE_CURL=0 -DJUCE_WEB_BROWSER=0 -DJUCE_USE_FLAC=1 -DJUCE_USE_OGGVORBIS=1
  -DJUCE_USE_MP3AUDIOFORMAT=1 -DJUCE_USE_LAME_AUDIO_FORMAT=0 -DJUCE_USE_WINDOWS_MEDIA_FORMAT=0
  -DMICFX_HAS_DEMUCS=0 -DMICFX_HAS_COREML=0 '-DJucePlugin_Name="MicFX"' -DJucePlugin_Build_Standalone=1
  -Wno-deprecated-declarations
)

mkdir -p "$work/obj-daw" "$out"
objdir="$work/obj-daw"

# An object per source, rebuilt when the source, the patched JUCE or a shim is newer.
newest_shim="$(find "$here/shim" "$here/shim-daw" "$here/cpp/daw" -type f -printf '%T@\n' | sort -n | tail -1)"
object_for() { echo "$objdir/$(echo "${1#$root/}" | tr '/' '_' | sed 's/\.[a-z]*$//').o"; }
needs_build() {
  local obj; obj="$(object_for "$1")"
  [ ! -f "$obj" ] || [ "$1" -nt "$obj" ] || [ "$stamp" -nt "$obj" ] || [ "$(stat -c %Y "$obj")" -lt "${newest_shim%.*}" ]
}
compile_one() {
  local src="$1" obj; obj="$(object_for "$1")"
  echo "  compile ${src#$root/}" >&2
  case "$src" in
    *.c) emcc "${base[@]}" -w -DHAVE_CONFIG_H -I"$juce" -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -DJUCE_USE_FLAC=1 \
           -I"$desktop/libs/lame" -I"$desktop/libs/lame/libmp3lame" -I"$desktop/libs/lame/include" -c "$src" -o "$obj" ;;
    *)   emcc "${flags[@]}" -c "$src" -o "$obj" ;;
  esac
}

d="$desktop/src"
sources=(
  "$here/cpp/daw/juce_daw_modules.cpp" "$here/cpp/daw/juce_daw_modules2.cpp" "$here/cpp/daw/juce_wasm_threads.cpp" "$here/cpp/daw/juce_wasm_files.cpp"
  "$here/cpp/daw/DawHost.cpp" "$here/cpp/daw/web_stubs.cpp" "$here/cpp/daw/WebHistory.cpp" "$here/cpp/daw/WebProject.cpp"
  "$d/PluginProcessor.cpp" "$d/DawBridge.cpp" "$d/DawActions.cpp" "$d/McpProtocol.cpp" "$d/McpServer.cpp"
  "$d/Parameters.cpp" "$d/Presets.cpp" "$d/Recorder.cpp" "$d/CaptureRing.cpp" "$d/LiveInstruments.cpp"
  "$d/Looper.cpp" "$d/MidiMap.cpp" "$d/LiveHistory.cpp" "$d/Scenes.cpp" "$d/Setlist.cpp" "$d/PresetLibrary.cpp"
  "$d/FactoryChains.cpp" "$d/SoundCheck.cpp" "$d/Multitrack.cpp" "$d/StarterContent.cpp"
  "$d/Practice.cpp" "$d/PracticeShift.cpp" "$d/ComputerAudio.cpp"
  "$d/stems/StemSplitter.cpp"
)
for f in "$d"/daw/*.cpp; do
  sources+=("$f")
done
for f in "$d"/analysis/*.cpp; do sources+=("$f"); done
for f in "$d"/instruments/*.cpp; do
  case "$(basename "$f")" in InstrumentEditor.cpp|PluginEntry.cpp) ;; *) sources+=("$f") ;; esac
done


sources+=("$desktop"/libs/lame/libmp3lame/*.c "$juce/juce_core/juce_core_zlib.c"
          "$juce/juce_audio_formats/juce_audio_formats_flac_1.c" "$juce/juce_audio_formats/juce_audio_formats_flac_2.c")

# Compiles what changed, a few at a time (MICFX_JOBS, default: every core).
jobs="${MICFX_JOBS:-$(nproc)}"
failed=0 running=0
for src in "${sources[@]}"; do
  needs_build "$src" || continue
  compile_one "$src" &
  running=$((running + 1))
  if [ "$running" -ge "$jobs" ]; then wait -n || failed=1; running=$((running - 1)); fi
  if [ "$failed" = 1 ] && [ -z "${MICFX_KEEP_GOING:-}" ]; then wait; exit 1; fi
done
while [ "$running" -gt 0 ]; do wait -n || failed=1; running=$((running - 1)); done
[ "$failed" = 0 ] || exit 1
objects=()
for src in "${sources[@]}"; do objects+=("$(object_for "$src")"); done

em++ -O2 -msimd128 -pthread ${MICFX_LDFLAGS:-} "${objects[@]}" -o "$out/daw.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDawModule -sENVIRONMENT=worker,node \
  -sWASMFS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=2097152 -sDEFAULT_PTHREAD_STACK_SIZE=2097152 -sPTHREAD_POOL_SIZE=6 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPF32,HEAPU8,HEAP32,UTF8ToString,stringToUTF8,lengthBytesUTF8,wasmMemory \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_main \
  -sEXIT_RUNTIME=0
echo "Built $(du -h "$out/daw.wasm" | cut -f1) $out/daw.wasm"
