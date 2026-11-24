import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STEMS_RATE, StemSeparator, planChunks, stitchChunks } from "../src/stems";

const wasm = new URL("../dist/stems.wasm", import.meta.url);
const model = process.env.MICFX_STEMS_MODEL;

describe("stems", () => {
  it("cuts a song into overlapping chunks and crossfades them back exactly", () => {
    const total = 100_000;
    const { chunks, overlap } = planChunks(total, 1000, 30, 1);
    expect(chunks.length).toBe(4);
    expect(chunks[1]).toEqual({ from: 29_000, to: 61_000 });
    expect(chunks.at(-1)!.to).toBe(total);

    // A "network" that hands the input back as two stems (itself and half of it).
    const song = Float32Array.from({ length: total }, (_, i) => Math.sin(i / 50));
    const separated = chunks.map(({ from, to }) => {
      const part = song.slice(from, to);
      return [[part, part], [part.map((v) => v / 2), part.map((v) => v / 2)]] as [Float32Array, Float32Array][];
    });
    const [whole, half] = stitchChunks(chunks, separated, total, overlap);
    let worst = 0;
    for (let i = 0; i < total; ++i) worst = Math.max(worst, Math.abs(whole![0]![i]! - song[i]!), Math.abs(half![1]![i]! - song[i]! / 2));
    expect(worst).toBeLessThan(1e-5);
  });

  it.skipIf(!model || !existsSync(model))("separates a voice from a backing with the desktop's model", { timeout: 300_000 }, () => {
    let progress = 0;
    const separator = new StemSeparator(new WebAssembly.Module(readFileSync(wasm)), (p) => (progress = p));
    expect(separator.load(readFileSync(model!))).toBe(4);

    // A sung tone over a kick-like thump, 8 s.
    const frames = 8 * STEMS_RATE;
    const left = new Float32Array(frames);
    for (let i = 0; i < frames; ++i) {
      const t = i / STEMS_RATE;
      let voice = 0;
      for (let h = 1; h <= 8; ++h) voice += Math.sin(2 * Math.PI * 220 * h * t * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t))) / h;
      const beat = t % 0.5;
      left[i] = 0.15 * voice + 0.5 * Math.sin(2 * Math.PI * 55 * beat) * Math.exp(-beat * 20);
    }
    const stems = separator.separate(left, left);
    expect(stems).toHaveLength(4);
    expect(progress).toBeGreaterThan(0.9);
    const energy = (x: Float32Array) => x.reduce((a, v) => a + v * v, 0);
    for (const [l, r] of stems) expect(l.length + r.length).toBe(2 * frames);
    expect(Number.isFinite(energy(stems[3]![0]!))).toBe(true);
    expect(energy(stems[3]![0]!) + energy(stems[0]![0]!)).toBeGreaterThan(0);
  });
});
