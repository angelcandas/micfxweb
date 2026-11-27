// "Try a sound": an idea through one of the Live screen's factory voice sounds (Radio, Studio, ...),
// rendered off the page's thread by the same engine.
import { instantiateEngineModule } from "@micfx/engine";

export type SoundRequest =
  | { kind: "list"; module: WebAssembly.Module }
  | { kind: "render"; module: WebAssembly.Module; samples: Float32Array; rate: number; preset: number };
export type SoundReply = { presets: { name: string; category: string }[] } | { samples: Float32Array } | { error: string };

self.onmessage = (event: MessageEvent<SoundRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "list") {
      const engine = instantiateEngineModule(request.module).create(44100, 128);
      const presets = engine.factoryPresets().map(({ name, category }) => ({ name, category }));
      engine.dispose();
      return post({ presets });
    }
    const { module, samples, rate, preset } = request;
    const engine = instantiateEngineModule(module).create(rate, 128);
    if (!engine.loadPreset(preset)) throw new Error("that sound isn't available");
    const tail = Math.round(rate * 1.2); // (the room and echoes ring out)
    const out = new Float32Array(samples.length + tail);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const input = new Float32Array(128);
    for (let at = 0; at < out.length; at += 128) {
      const n = Math.min(128, out.length - at);
      input.fill(0);
      if (at < samples.length) input.set(samples.subarray(at, Math.min(samples.length, at + n)));
      engine.render(input.subarray(0, n), left, right);
      for (let i = 0; i < n; i++) out[at + i] = (left[i]! + right[i]!) / 2;
    }
    engine.dispose();
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
    const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * gain;
    post({ samples: out }, [out.buffer]);
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) });
  }
};

function post(reply: SoundReply, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(reply, transfer);
}
