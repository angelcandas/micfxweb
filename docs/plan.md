# MicFX on the web: plan

Two web apps in this one repo, sharing one audio core:

- **MicFX Voice** (ships first): live voice effects on your mic, presets, recording, backing tracks, then Practice (sing any song, with pitch scoring and coaching).
- **MicFX DAW** (later): the track editor, mixing and Auto Mix.

The desktop app ([angelcandas/local-mic-effects](https://github.com/angelcandas/local-mic-effects)) stays the single source of the DSP and analysis code. The web apps compile that same C++ to WebAssembly instead of rewriting it.

## 1. The decision: port, don't rewrite

I tried it before writing this plan (2026-11-24, Emscripten 7.0.1, the JUCE commit the desktop repo pins):

| Check | Result |
| --- | --- |
| `juce_core` + `juce_audio_basics` + `juce_audio_formats` + `juce_dsp` built for wasm | Works after a **3-line patch** (thread priority table and one missing `#include <emscripten.h>`) plus a 6-line stub file (`Thread`, `MemoryMappedFile`) |
| The desktop `fx::FxChain` with all 38 module types, unchanged, from `src/dsp/` | Compiles and runs. Wasm binary is **~700 KB** |
| Speed: 13 effects on at once (high-pass, denoise, gate, autotune, harmonizer, EQ, compressor, de-esser, echo, reverb, doubler, chorus, width), 48 kHz, 128-sample blocks, Node 22 | 10 s of audio in 0.51 s, so **about 5% of one core**. Fine inside an AudioWorklet |
| No threads (`-pthread` off) | Works. So the engine can run inside an AudioWorklet without SharedArrayBuffer, and the site needs no special COOP/COEP headers |

A rewrite in JS or Rust would mean keeping two copies of 9,000 lines of DSP (and 26 effects' worth of tuning) in step forever. The port keeps one.

What does **not** port as is: anything on `juce_events`, `juce_gui_*` and `juce_audio_processors` (the `AudioProcessorValueTreeState`, the editor, plug-in hosting, file choosers, the message thread). Those are the "app shell" parts, and the web shell replaces them with a small amount of TypeScript.

## 2. Architecture

```
┌──────────────────────── main thread (page) ─────────────────────────┐
│  Desktop UI, reused (ui/*.js, *.css from the desktop repo)          │
│        │ Juce.getNativeFunction(...), getSliderState(...), events   │
│  packages/bridge: a browser version of JUCE's frontend library      │
│        │ native functions implemented in TS                         │
│  packages/host: AudioContext, mic, devices, presets, storage        │
└────────┬───────────────────────────────────────────────▲────────────┘
         │ port.postMessage (values, preset, order)      │ meters, pitch, ~30/s
┌────────▼───────────────── AudioWorklet thread ─────────┴────────────┐
│  packages/engine: engine.wasm = desktop src/dsp + LiveEngine wrapper │
│  mic → input gain → FxChain (Live order) → output gain → limiter    │
└─────────────────────────────────────────────────────────────────────┘
  Web Workers (later): key/chord detection, Practice melody (analysis/), stems (demucs.cpp wasm)
  Storage: IndexedDB for settings and user presets, OPFS for songs, takes and stem caches
```

### Audio path

- `getUserMedia` with `echoCancellation`, `noiseSuppression` and `autoGainControl` **off** (the browser's own voice processing would fight our effects and add latency), `AudioContext({ latencyHint: "interactive" })`, at the device rate.
- The wasm module is compiled once on the main thread (`WebAssembly.compileStreaming`) and handed to the AudioWorkletProcessor, which instantiates it synchronously. No pthreads, no SharedArrayBuffer, so it works on GitHub Pages or any static host.
- The worklet processes 128-frame render quanta (2.7 ms at 48 kHz). The engine prepares for 128 and runs once per quantum.
- Values go to the worklet as messages (`{ id, value }` with the desktop parameter IDs, e.g. `reverbOn`, `tuneSpeed`), and the C++ side calls `FxChain::setValue`, the same call the desktop uses. Module values already glide over ~15 ms, so knob moves don't click.
- Meters, the detected pitch and the effects' own meters (`FxMeter`) come back about 30 times a second. A SharedArrayBuffer ring can replace messages later if it turns out to matter, behind cross-origin isolation.
- Output device choice: `AudioContext.setSinkId` where supported (Chrome, Edge), hidden elsewhere.

### Latency

Browsers add their own buffering on top of the 2.7 ms quantum. Realistic round trip with wired headphones: about 10–20 ms in Chrome on macOS, 20–40 ms on Windows, more with Bluetooth (unusable for live monitoring). The app shows the measured figure (`baseLatency + outputLatency` plus the input estimate) next to the "Low latency" tips, just as the desktop shows its readout. Effects that add latency (autotune's half pitch period) add the same few ms as on desktop.

### The C++ engine wrapper (`packages/engine`)

A thin `LiveEngine` class, written for the web but kept free of browser code so it could move upstream later:

- Owns one `fx::FxChain` of every module in Live order, the input and output gains, the hold-for-dry switch and the −1 dB safety limiter, the same signal path as `PluginProcessor::processBlock` in Live mode.
- Exposes a small C API through `extern "C"`: `create(sampleRate, maxBlock)`, `process(in, out, frames)`, `setValue(id, value)`, `setOrder(keys)`, `readMeters(out)`, `readPitch(out)`.
- Is built by `packages/engine/build.sh` with Emscripten (`-O2 -msimd128`, no pthreads, `-sSTANDALONE_WASM`, so there is no Emscripten JS glue and the worklet instantiates it itself). The same wasm runs in Node for the tests.
- Tests run in Node against the wasm: every factory preset renders a voice-like test signal without NaN/Inf/clipping past the limiter, and a few presets' output is compared with numbers from the desktop build (golden files), so a drift between the two is caught.

## 3. Shared core strategy

- `extern/local-mic-effects` is a **git submodule** of the desktop repo, pinned to a commit (both repos are public, so CI needs no token). JUCE comes through that repo's own `libs/JUCE` submodule, so web and desktop always build against the same JUCE.
- The web build compiles the desktop sources directly: `src/dsp/*.h`, `src/analysis/*.cpp` (Key, Chords, Pitch, Coach, Lyrics, Structure), `src/PitchTap.h`, the factory presets' values.
- `patches/juce-wasm.patch` (the 3-line JUCE fix) is applied to a copy at build time, and `packages/engine/src/juce_wasm_stubs.cpp` fills in the two missing JUCE symbols. Nothing is forked.
- **Rule: no DSP forks here.** A DSP or analysis fix goes into the desktop repo, then the submodule is bumped here. The web repo only holds the wrapper, the bridge and the web shell.
- Two small upstream PRs in the desktop repo make this cleaner (neither changes the desktop app's behaviour):
  1. Move the parameter list (IDs, ranges, defaults, units, choices) and the factory preset values out of `Parameters.cpp`/`Presets.cpp` into a JUCE-free table header that both the desktop `Parameters` and the web engine read. Until then the web build generates that table once from the desktop app's `getParameterInfo`/`getParameterDefaults` output and checks it in.
  2. A CI job in the desktop repo that compiles `src/dsp` and `src/analysis` for wasm, so a desktop change can't silently break the web build.

### What ports, module by module

| Desktop code | Web | How |
| --- | --- | --- |
| `src/dsp/*` (all 26 Live effects, mastering, amp/cab, denoise) | ✅ Voice MVP | As is (verified) |
| `PitchTap`, `analysis/Pitch`, `Key`, `Chords` | ✅ Voice | As is (Key/Chords verified) |
| `Presets`, `FactoryChains`, `Parameters` | ✅ Voice | Values via the shared table, applied by the wrapper instead of the APVTS |
| `Looper`, `Recorder` | ✅ Voice, later PR | Looper's DSP as is; recording writes WAV in JS (or `juce_audio_formats` WAV writer to memory) and saves to a download/OPFS |
| `analysis/Coach`, `Lyrics`, `Structure`, `Practice` logic | ✅ Voice, Practice phase | Analysis in a Worker; the `Practice` class's file and thread handling rewritten in TS |
| `stems/` (demucs.cpp) | ⚠️ Practice phase | demucs.cpp already runs in wasm in other projects; minutes per song on a laptop, so it runs in a Worker with progress, caches the stems in OPFS, and "voice-only" songs skip it. A server option is a later decision |
| `SoundCheck` planner, `analysis/*` | ✅ Voice | `analysis.wasm` in a Worker, built with `juce_events` and `juce_data_structures` (patched: a message queue and timers the page runs, `juce::wasmDispatchMessages`); the linker drops the DAW parts the sound check never calls |
| `Multitrack`, `daw/*` engine, `Warp`, `Exporter`, `analysis/Mix*` | ⏳ DAW app | `daw/*`, `analysis/*` and the instruments' DSP already compile for wasm with the `juce_events` patch and the fuller shim; left: `PluginHost` (no plug-ins on the web), the instruments' editors, LAME for MP3 |
| `instruments/*` | ⏳ DAW app | DSP should port; Web MIDI for input |
| `PluginHost`, `PluginInsert` (VST3/AU) | ❌ | Not possible in a browser |
| `McpServer`, `ComputerAudio` (system audio) | ❌ / later | No local server in a browser; tab audio capture via `getDisplayMedia` is possible later in Chrome |

## 4. UI reuse

The desktop UI is already HTML/CSS/JS talking to C++ through JUCE's frontend library (`ui/juce/index.js`): Live mode uses 39 native functions, 24 parameter states (`getSliderState`/`getToggleState`/`getComboBoxState`) and 31 events.

**Plan: reuse the desktop UI files, swap the bridge.** `packages/bridge` provides a browser implementation of the same API (`getNativeFunction`, the slider/toggle/combo states, `window.__JUCE__.backend` events) backed by the web host and the worklet. The Voice app serves the desktop's `ui/` files from the submodule with that bridge in place of `ui/juce/index.js`, so the effect cards, knobs, presets menu, devices view and Practice view stay one codebase.

- Each native function is implemented in TS (presets, `uiPref`, `audioSetup`, `chainOrder`, ...), or answers "not available on the web" for desktop-only ones (`chooseRecordingFolder`, `computerAudio`, plug-ins, MCP).
- The page learns it is on the web from a `platform` native function, and the desktop UI hides what can't work there (DAW switch, recording folder, plug-ins). That's a few small upstream UI changes, made in the desktop repo and harmless there.
- File pickers become `<input type=file>`/File System Access, saves become downloads or OPFS.
- If a part of the desktop UI turns out too tied to the desktop (window chrome, menus), the Voice app overrides just that part, not the whole UI.
- Mobile: Voice MVP targets desktop browsers (Chrome, Edge, Firefox, Safari). Phones work in principle but latency on phones is usually too high for live monitoring, so a phone layout comes after the MVP.

## 5. Repo layout

```
micfxweb/
  apps/
    voice/            Vite app: index.html, src/main.ts, the web-only views, public/
    daw/              (later)
  packages/
    engine/           C++ wrapper (LiveEngine, C API), CMakeLists, wasm build, worklet processor, Node tests
    bridge/           JUCE frontend API for the browser + native-function registry
    host/             AudioContext, mic/devices, latency readout, storage (IndexedDB/OPFS)
  extern/
    local-mic-effects/   git submodule (desktop repo, pinned)
  patches/
    juce-wasm.patch
  docs/plan.md        this file
  .github/workflows/  ci.yml (build wasm, tests, Playwright smoke), pages.yml (deploy)
  package.json, pnpm-workspace.yaml, tsconfig.base.json
```

Tooling: pnpm workspaces, TypeScript, Vite, Vitest for TS, Playwright (Chromium with a fake mic) for the page, Emscripten via `mymindstorm/setup-emsdk` in CI with the emsdk version pinned.

Hosting: GitHub Pages from `main` (free for a public repo, static files only, works since we need no special headers). Installable as a PWA so it runs offline once loaded.

Licence: the desktop code and JUCE are used under the AGPLv3, so this repo is AGPLv3 too and the deployed site links to its source.

## 6. MicFX Voice MVP scope

In:

- Mic in → all 26 Live effects → headphones, with input/output level, meters and the effect cards' own meters.
- The 24 factory voice presets and the effect order; user presets saved in the browser (and export/import as files).
- Hold for dry, input gain and output level, the tuner/pitch readout, the autotune key and scale.
- Input and output device choice, latency readout and a "use wired headphones" hint.
- Record yourself (wet, or dry + wet) and download as WAV.
- Play a backing track from a file, with key detection to set the autotune key.

After the MVP, still in Voice: looper, scenes and setlist, MIDI learn (Web MIDI), then **Practice** (songs from file, voice-only first, then stem splitting in a Worker, pitch trail, scores, coaching, lyrics).

Out of Voice: the DAW, plug-ins, MCP, computer audio.

## 7. PR sequence

Each PR is small enough to review, has CI, and UI PRs carry screenshots.

1. **Scaffold**: monorepo layout, pnpm workspace, submodule, this plan, CI that installs and type-checks.
2. **Engine to wasm**: CMake/Emscripten build of `LiveEngine` + the desktop FxChain, the JUCE patch and stubs, C API, Node tests (every module on, presets without NaN or overs), wasm built in CI.
3. **Sound in the browser**: the worklet processor, mic capture, one minimal page with a power button, preset picker and meters. Playwright with Chromium's fake mic checks audio flows. First deployable build.
4. **Parameters and presets**: the shared parameter table and factory presets in the engine; values, order and presets from the page.
5. **Desktop UI on the web bridge**: `packages/bridge`, the Voice app serving the desktop Live UI with web-only features hidden (plus the upstream `platform` change in the desktop repo).
6. **Devices, storage, latency**: input/output pickers, user presets and UI prefs in IndexedDB, latency readout.
7. **Record and backing track**: WAV recording to download, backing track from file, key detection in a Worker.
8. **Deploy**: Cloudflare Pages from CI (chosen over GitHub Pages; see docs/deploy.md), PWA manifest and offline cache, link to source.
9+. Looper, scenes/setlist, MIDI learn; then Practice (voice-only songs → stems in a Worker → coaching and lyrics).

Then **MicFX DAW**: plan the `juce_events` shim (a message queue on the main thread) so `daw/*` and `Multitrack` can compile, decide where Auto Mix analysis runs (Workers, with the heavier learning parts possibly server-side), and reuse `daw.js` through the same bridge.

## 8. Risks and open questions

- **Latency on Windows and Bluetooth** is outside our control. We measure and say so in the app, rather than promise desktop numbers.
- **Safari** has had AudioWorklet and `getUserMedia` quirks (sample-rate changes, no `setSinkId`). Supported, but tested after Chrome and Firefox.
- **Stem splitting speed** in the browser decides how Practice feels. If it is too slow on typical laptops, we offer voice-only songs and a later server option.
- **Upstream changes** (parameter table, platform flag, wasm CI job) touch the desktop repo; they are behaviour-neutral there and go through its normal CI.
- **Parameter list drift** until the shared table lands: covered by a generated, checked-in table and a test that compares it with the desktop's.
