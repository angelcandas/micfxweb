// mp3.wasm: the desktop's MP3 encoder (LAME), with the desktop's quality steps (Mp3Writer.h).
import { makeImports } from "./engine";

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(at: number): void;
  micfx_mp3_open(rate: number, channels: number, quality: number, title: number, year: number, comment: number): number;
  micfx_mp3_encode(flags: number, left: number, right: number, frames: number, out: number, size: number): number;
  micfx_mp3_finish(flags: number, out: number, size: number): number;
  micfx_mp3_lametag(flags: number, out: number, size: number): number;
  micfx_mp3_close(flags: number): void;
}

/** The desktop's quality steps; 2 (192 kbps) is its default. */
export const MP3_QUALITIES = ["128 kbps", "160 kbps", "192 kbps", "256 kbps", "320 kbps", "Variable, high (about 190 kbps)", "Variable, highest (about 245 kbps)"];
export const MP3_DEFAULT_QUALITY = 2;

export interface Mp3Tags {
  title?: string;
  /** Four digits. */
  year?: string;
  comment?: string;
}

const BLOCK = 8192;

/**
 * One or two channels as an MP3 file (bytes), with an ID3 tag. LAME takes 32, 44.1 or 48 kHz
 * (and lower) as they are.
 */
export function encodeMp3(module: WebAssembly.Module, channels: Float32Array[], rate: number, quality = MP3_DEFAULT_QUALITY, tags: Mp3Tags = {}): Uint8Array {
  let exports: Exports | undefined;
  const instance = new WebAssembly.Instance(module, makeImports(() => exports!.memory));
  exports = instance.exports as unknown as Exports;
  exports._initialize();
  const x = exports;
  const count = Math.min(2, Math.max(1, channels.length));
  const frames = channels[0]?.length ?? 0;

  const text = (value?: string) => {
    if (!value) return 0;
    // ID3 v1/v2 here take Latin-1; anything else becomes "?"
    const bytes = Uint8Array.from(value.slice(0, 120), (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
    const at = x.malloc(bytes.length + 1);
    new Uint8Array(x.memory.buffer, at, bytes.length + 1).set([...bytes, 0]);
    return at;
  };
  const strings = [text(tags.title), text(tags.year), text(tags.comment)];
  const flags = x.micfx_mp3_open(Math.round(rate), count, quality, strings[0]!, strings[1]!, strings[2]!);
  for (const at of strings) if (at) x.free(at);
  if (!flags) throw new Error("The MP3 encoder couldn't start (sample rate?).");

  const size = Math.ceil(BLOCK * 1.25) + 7200;
  const left = x.malloc(BLOCK * 4);
  const right = x.malloc(BLOCK * 4);
  const out = x.malloc(size);
  const parts: Uint8Array[] = [];
  try {
    for (let from = 0; from < frames; from += BLOCK) {
      const n = Math.min(BLOCK, frames - from);
      new Float32Array(x.memory.buffer, left, n).set(channels[0]!.subarray(from, from + n));
      new Float32Array(x.memory.buffer, right, n).set((channels[count - 1] ?? channels[0]!).subarray(from, from + n));
      const bytes = x.micfx_mp3_encode(flags, left, right, n, out, size);
      if (bytes < 0) throw new Error(`The MP3 encoder failed (${bytes}).`);
      if (bytes) parts.push(new Uint8Array(x.memory.buffer, out, bytes).slice());
    }
    const tail = x.micfx_mp3_finish(flags, out, size);
    if (tail > 0) parts.push(new Uint8Array(x.memory.buffer, out, tail).slice());

    const file = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) file.set(part, (at += part.length) - part.length);
    // The first frame's Xing/LAME header, now that the lengths are known (players seek by it).
    const tag = x.micfx_mp3_lametag(flags, out, size);
    if (tag > 0 && tag <= size) {
      const start = id3v2Size(file);
      if (start + tag <= file.length) file.set(new Uint8Array(x.memory.buffer, out, tag), start);
    }
    return file;
  } finally {
    x.free(left);
    x.free(right);
    x.free(out);
    x.micfx_mp3_close(flags);
  }
}

function id3v2Size(file: Uint8Array): number {
  if (file[0] !== 0x49 || file[1] !== 0x44 || file[2] !== 0x33) return 0; // "ID3"
  return 10 + ((file[6]! & 0x7f) << 21) + ((file[7]! & 0x7f) << 14) + ((file[8]! & 0x7f) << 7) + (file[9]! & 0x7f) + (file[5]! & 0x10 ? 10 : 0);
}
