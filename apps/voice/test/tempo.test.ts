import { describe, expect, it } from "vitest";
import { estimateTempo } from "../src/capture/tempo";
import { shrink } from "../src/capture/recorder";
import { readSamples, toInt16, wavHeader } from "../src/capture/wav";

function clicks(bpm: number, seconds: number, rate = 16000) {
  const out = new Float32Array(seconds * rate);
  const step = Math.round((60 / bpm) * rate);
  for (let at = 0; at < out.length; at += step) for (let i = 0; i < 400 && at + i < out.length; i++) out[at + i] = Math.sin(i * 0.5) * Math.exp(-i / 100);
  return out;
}

describe("tempo", () => {
  it("finds the pulse of a click track", () => {
    for (const bpm of [90, 120, 140]) {
      const guess = estimateTempo(clicks(bpm, 20), 16000);
      expect(guess?.bpm).toBeGreaterThanOrEqual(bpm - 2);
      expect(guess?.bpm).toBeLessThanOrEqual(bpm + 2);
    }
  });
  it("says nothing about steady noise or a short clip", () => {
    const noise = Float32Array.from({ length: 16000 * 20 }, () => (Math.random() - 0.5) * 0.2);
    expect(estimateTempo(noise, 16000)).toBeUndefined();
    expect(estimateTempo(clicks(100, 3), 16000)).toBeUndefined();
  });
});

describe("wav and peaks", () => {
  it("round-trips samples through the header", () => {
    const wav = new Uint8Array([...wavHeader(44100, 3), ...new Uint8Array(toInt16(new Float32Array([0, 0.5, -0.5])).buffer)]);
    const { samples, rate } = readSamples(wav.buffer);
    expect(rate).toBe(44100);
    expect(samples[1]).toBeCloseTo(0.5, 2);
    expect(samples[2]).toBeCloseTo(-0.5, 2);
  });
  it("shrinks to at most 240 bars", () => {
    expect(shrink([])).toEqual([]);
    expect(shrink(Array.from({ length: 1000 }, (_, i) => i / 1000)).length).toBe(240);
    expect(shrink([0.25, 1]).length).toBe(2);
  });
});
