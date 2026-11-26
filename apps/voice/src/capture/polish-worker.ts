// "Make it sound good": the voice through the desktop's own clean-up (high-pass, denoise,
// compressor, de-esser, a touch of room), rendered off the page's thread.
import { instantiateEngineModule } from "@micfx/engine";

export interface PolishRequest { module: WebAssembly.Module; samples: Float32Array; rate: number }
export type PolishReply = { samples: Float32Array } | { error: string };

self.onmessage = (event: MessageEvent<PolishRequest>) => {
  const { module, samples, rate } = event.data;
  try {
    const engine = instantiateEngineModule(module).create(rate, 128);
    for (const info of engine.valueInfo()) if (info.isSwitch) engine.setValue(info.id, 0);
    for (const id of ["hpfOn", "denoiseOn", "compOn", "deessOn", "reverbOn"]) engine.setValue(id, 1);
    engine.setValue("reverbMix", 10);
    engine.setValue("reverbSize", 30);
    const out = new Float32Array(samples.length);
    const left = new Float32Array(128), right = new Float32Array(128);
    for (let at = 0; at < samples.length; at += 128) {
      const block = samples.subarray(at, Math.min(samples.length, at + 128));
      engine.render(block, left, right);
      for (let i = 0; i < block.length; i++) out[at + i] = (left[i]! + right[i]!) / 2;
    }
    engine.dispose();
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
    const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1; // up to 12 dB, to -1 dBFS
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * gain;
    (self as unknown as Worker).postMessage({ samples: out } satisfies PolishReply, [out.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ error: String(error) } satisfies PolishReply);
  }
};
