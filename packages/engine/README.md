# @micfx/engine

The desktop MicFX DSP (`extern/local-mic-effects/src/dsp`, unchanged) compiled to WebAssembly, with a
small wrapper (`cpp/LiveEngine`) that runs Live mode's voice path:

```
mic -> input gain -> FxChain (every effect, Live order) -> output gain -> limiter (-1 dB)
```

- `build.sh` builds `dist/engine.wasm` (needs `emcc` on the PATH, Emscripten 7.0.1 in CI). JUCE is copied
  and patched with `patches/juce-wasm.patch`; the submodule stays clean.
- `src/engine.ts` loads it anywhere (AudioWorklet, Node) and wraps the C API in `cpp/api.cpp`.
- `pnpm test` runs the wasm in Node: parameter IDs, order, every effect at once, the limiter, meters, speed.

Values use the desktop parameter IDs (`reverbOn`, `tuneSpeed`, ...) in real units.
