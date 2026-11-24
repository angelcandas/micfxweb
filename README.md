# MicFX web

Web versions of [MicFX](https://github.com/angelcandas/local-mic-effects):

- **MicFX Voice**: live voice effects on your mic, presets, recording, backing tracks, then Practice. Ships first.
- **MicFX DAW**: the track editor, mixing and Auto Mix. Later.

Both compile the desktop app's C++ DSP to WebAssembly and run it in an AudioWorklet, so the effects sound
the same as on the desktop. The plan, architecture and PR sequence: [docs/plan.md](docs/plan.md).

## Layout

| Path | What |
| --- | --- |
| `apps/voice` | MicFX Voice (Vite app) |
| `packages/` | Shared engine (wasm), bridge and host code |
| `extern/local-mic-effects` | The desktop repo as a submodule: the single source of the DSP |

## Develop

Needs Node 22 and pnpm 10.

```sh
pnpm deps        # fetch the desktop core and JUCE (submodules)
pnpm install
pnpm dev         # MicFX Voice on http://localhost:5173
```

DSP changes go to the desktop repo; then bump the submodule here.

## Licence

AGPLv3, like the desktop app and the JUCE code it uses.
