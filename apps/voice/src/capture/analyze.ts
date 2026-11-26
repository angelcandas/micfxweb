// What the app works out about an idea after the take, off the page's thread.
import type { KeyEstimate } from "@micfx/engine";
import wasmUrl from "@micfx/engine/engine.wasm?url";
import KeyWorker from "../key-worker?worker";
import type { Idea } from "./store";
import { estimateTempo } from "./tempo";
import { readSamples } from "./wav";

let compiled: Promise<WebAssembly.Module> | undefined;
function engineModule() {
  compiled ??= fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b));
  return compiled;
}

async function findKey(mono: Float32Array, rate: number): Promise<KeyEstimate | undefined> {
  const module = await engineModule();
  const worker = new KeyWorker();
  try {
    return await new Promise<KeyEstimate | undefined>((resolve) => {
      worker.onmessage = (event: MessageEvent<KeyEstimate | { ok: false }>) => resolve(event.data.ok ? (event.data as KeyEstimate) : undefined);
      worker.onerror = () => resolve(undefined);
      worker.postMessage({ module, mono, sampleRate: rate });
    });
  } finally {
    worker.terminate();
  }
}

/** The key and the tempo, when there's enough to say (a few seconds of a clear pitch). */
export async function analyse(wav: Blob): Promise<Pick<Idea, "key" | "bpm" | "analysed">> {
  const { samples, rate } = readSamples(await wav.arrayBuffer());
  const result: Pick<Idea, "key" | "bpm" | "analysed"> = { analysed: true };
  if (samples.length < rate * 4) return result;
  const tempo = estimateTempo(samples, rate);
  if (tempo) result.bpm = tempo.bpm;
  try {
    const key = await findKey(samples.slice(), rate);
    if (key && key.key >= 0 && key.confidence >= 0.08) result.key = key.name;
  } catch { /* no key: fine */ }
  return result;
}
