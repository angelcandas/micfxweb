import { describe, expect, it } from "vitest";
import { renderBeat, BEAT_STYLES } from "../src/capture/beat";
import { droneHz, parseKey } from "../src/capture/playalong";

describe("beat", () => {
  it("makes sound for every style, in length and below full scale", () => {
    for (const style of BEAT_STYLES) {
      const beat = renderBeat(style, 100, 10, 16000);
      expect(beat.length).toBe(160000);
      const peak = beat.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak).toBeGreaterThan(0.2);
      expect(peak).toBeLessThanOrEqual(0.81);
    }
  });
  it("puts a kick on the first beat of each bar", () => {
    const rate = 16000;
    const beat = renderBeat("Basic", 120, 8, rate);
    const bar = rate * 2; // 4 beats at 120 BPM
    for (const start of [0, bar, bar * 2]) {
      let energy = 0;
      for (let i = start; i < start + 800; i++) energy += beat[i]! * beat[i]!;
      expect(energy).toBeGreaterThan(1);
    }
  });
});

describe("keys", () => {
  it("reads the key names the analysis gives", () => {
    expect(parseKey("A minor")).toEqual({ tonic: 9, minor: true });
    expect(parseKey("E♭ major")).toEqual({ tonic: 3, minor: false });
    expect(parseKey("F# minor")).toEqual({ tonic: 6, minor: true });
    expect(parseKey("nonsense")).toBeUndefined();
    expect(parseKey(undefined)).toBeUndefined();
  });
  it("puts the drone in the bass", () => {
    expect(droneHz(0)).toBeCloseTo(65.4, 1);
    expect(droneHz(9)).toBeGreaterThan(100);
    expect(droneHz(11)).toBeLessThan(135);
  });
});
