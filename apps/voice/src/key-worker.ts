// Finds a song's key off the page's thread (a few seconds for a whole song).
import { instantiateEngineModule, type KeyEstimate } from "@micfx/engine";

export interface KeyRequest {
  module: WebAssembly.Module;
  mono: Float32Array;
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<KeyRequest>) => {
  const { module, mono, sampleRate } = event.data;
  let result: KeyEstimate | { ok: false; error: string };
  try {
    const engine = instantiateEngineModule(module).create(sampleRate, 128);
    result = engine.detectKey(mono, sampleRate);
    engine.dispose();
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  self.postMessage(result);
};
