// stems.wasm: the desktop's stem splitter network (Demucs v4 by demucs.cpp) and its chunking
// (src/stems/StemSplitter.cpp): a song is cut into 30 s chunks that overlap by 1 s, each is
// separated on its own (in several Workers at once), and they are crossfaded back together.
import { makeImports } from "./engine";

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(at: number): void;
  micfx_stems_load(data: number, size: number): number;
  micfx_stems_separate(left: number, right: number, frames: number, out: number): number;
}

/** The weights (MIT), the same file the desktop downloads; about 84 MB, checked by its SHA-256. */
export const STEMS_MODEL = {
  url: "https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-4s-f16.bin",
  fileName: "ggml-model-htdemucs-4s-f16.bin",
  sha256: "72b17c42d308982ddb5069bc3bf48b81a5aac4cb6516e4366c0fa7cef6df0064",
  megabytes: 84,
};

/** What the model was trained on: songs are separated at this rate. */
export const STEMS_RATE = 44100;
export const STEM_NAMES = ["Drums", "Bass", "Other", "Vocals", "Guitar", "Piano"];
const CHUNK_SECONDS = 30;
const OVERLAP_SECONDS = 1;

export class StemSeparator {
  private readonly x: Exports;
  private stems = 0;

  /** `onProgress` hears how far the chunk being separated is (0..1). */
  constructor(module: WebAssembly.Module, onProgress: (progress: number) => void = () => {}) {
    let exports: Exports | undefined;
    const imports = makeImports(() => exports!.memory);
    (imports.env as Record<string, unknown>).micfx_stems_progress = (p: number) => onProgress(p);
    const instance = new WebAssembly.Instance(module, imports);
    exports = instance.exports as unknown as Exports;
    exports._initialize();
    this.x = exports;
  }

  /** The weights; the number of stems they give (4 or 6). Throws when they don't load. */
  load(weights: Uint8Array): number {
    const at = this.x.malloc(weights.length);
    if (!at) throw new Error("Not enough memory for the separation model.");
    try {
      new Uint8Array(this.x.memory.buffer, at, weights.length).set(weights);
      this.stems = this.x.micfx_stems_load(at, weights.length);
    } finally {
      this.x.free(at);
    }
    if (!this.stems) throw new Error("The separation model didn't load.");
    return this.stems;
  }

  /** One stereo chunk at STEMS_RATE: each stem's [left, right]. */
  separate(left: Float32Array, right: Float32Array): [Float32Array, Float32Array][] {
    const frames = left.length;
    const bytes = frames * 4;
    const l = this.x.malloc(bytes);
    const r = this.x.malloc(bytes);
    const out = this.x.malloc(bytes * 2 * Math.max(1, this.stems));
    if (!l || !r || !out) throw new Error("Not enough memory to separate the song.");
    try {
      new Float32Array(this.x.memory.buffer, l, frames).set(left);
      new Float32Array(this.x.memory.buffer, r, frames).set(right.length === frames ? right : left);
      const count = this.x.micfx_stems_separate(l, r, frames, out);
      const all = new Float32Array(this.x.memory.buffer, out, count * 2 * frames);
      return Array.from({ length: count }, (_, s) => [all.slice(2 * s * frames, (2 * s + 1) * frames), all.slice((2 * s + 1) * frames, (2 * s + 2) * frames)]);
    } finally {
      this.x.free(l);
      this.x.free(r);
      this.x.free(out);
    }
  }
}

/** A chunk of the song: it owns [k * chunk, (k + 1) * chunk) and reads `overlap` either side. */
export interface StemChunk {
  from: number;
  to: number;
}

export function planChunks(total: number, rate = STEMS_RATE, chunkSeconds = CHUNK_SECONDS, overlapSeconds = OVERLAP_SECONDS): { chunks: StemChunk[]; overlap: number } {
  const chunk = Math.max(1, Math.round(chunkSeconds * rate));
  const overlap = Math.max(0, Math.round(overlapSeconds * rate));
  const count = Math.max(1, Math.ceil(total / chunk));
  const chunks = Array.from({ length: count }, (_, k) => ({ from: Math.max(0, k * chunk - overlap), to: Math.min(total, (k + 1) * chunk + overlap) }));
  return { chunks, overlap };
}

/** The chunks' stems crossfaded back together (the desktop's chunkWeight). */
export function stitchChunks(chunks: StemChunk[], separated: [Float32Array, Float32Array][][], total: number, overlap: number): [Float32Array, Float32Array][] {
  const count = separated[0]?.length ?? 0;
  if (!count || separated.some((s) => s.length !== count)) throw new Error("The chunks came back with different stems.");
  const result = Array.from({ length: count }, () => [new Float32Array(total), new Float32Array(total)] as [Float32Array, Float32Array]);
  const weights = new Float32Array(total);
  chunks.forEach(({ from, to }, k) => {
    const first = k === 0;
    const last = k === chunks.length - 1;
    for (let i = from; i < to; ++i) {
      let w = 1;
      if (!first && overlap > 0) w = Math.min(w, (i - from) / (2 * overlap));
      if (!last && overlap > 0) w = Math.min(w, (to - i) / (2 * overlap));
      w = Math.max(0, Math.min(1, w));
      weights[i]! += w;
      for (let s = 0; s < count; ++s)
        for (let ch = 0; ch < 2; ++ch) {
          const stem = separated[k]![s]![ch]!;
          result[s]![ch]![i]! += w * stem[Math.min(i - from, stem.length - 1)]!;
        }
    }
  });
  for (let i = 0; i < total; ++i) {
    const w = weights[i]!;
    if (w > 0) for (const stem of result) for (const channel of stem) channel[i]! /= w;
  }
  return result;
}
