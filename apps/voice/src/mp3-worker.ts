// Encodes MP3 off the page (LAME in mp3.wasm), so a long take doesn't stall the controls.
import { encodeMp3, type Mp3Tags } from "@micfx/engine/mp3";

export type Mp3Request = { module: WebAssembly.Module; channels: Float32Array[]; rate: number; quality: number; tags: Mp3Tags };
export type Mp3Reply = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<Mp3Request>) => {
  const { module, channels, rate, quality, tags } = event.data;
  try {
    const bytes = encodeMp3(module, channels, rate, quality, tags);
    (self as unknown as Worker).postMessage({ ok: true, bytes } satisfies Mp3Reply, [bytes.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Mp3Reply);
  }
};
