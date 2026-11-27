import { describe, expect, it } from "vitest";
import { reduceVoice } from "../src/vocal-reduce";

const RATE = 44100;
const sine = (hz: number, n: number, gain: number) => Float32Array.from({ length: n }, (_, i) => gain * Math.sin((2 * Math.PI * hz * i) / RATE));
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe("reduceVoice", () => {
  it("takes down what is centred and keeps what is at the sides", () => {
    const n = RATE;
    const voice = sine(440, n, 0.4); // the same in both channels
    const guitar = sine(660, n, 0.3); // only on the left
    const left = voice.map((v, i) => v + guitar[i]!);
    const right = Float32Array.from(voice);
    const { audio, reduced } = reduceVoice([left, right], RATE);
    expect(reduced).toBe(true);
    // 440 Hz (the voice) is gone from the output, 660 Hz (the guitar) is there.
    const dot = (x: Float32Array, hz: number) => {
      let c = 0;
      let s = 0;
      for (let i = 0; i < x.length; i++) {
        c += x[i]! * Math.cos((2 * Math.PI * hz * i) / RATE);
        s += x[i]! * Math.sin((2 * Math.PI * hz * i) / RATE);
      }
      return Math.hypot(c, s) / x.length;
    };
    expect(dot(audio[0], 440)).toBeLessThan(0.02);
    expect(dot(audio[0], 660)).toBeGreaterThan(0.05);
  });

  it("hands a mono song back as it was", () => {
    const mono = sine(300, 4000, 0.5);
    const { audio, reduced } = reduceVoice([mono, mono], RATE);
    expect(reduced).toBe(false);
    expect(audio[0]).toBe(mono);
    expect(rms(audio[1])).toBeGreaterThan(0.3);
  });

  it("keeps the bass of the middle", () => {
    const n = RATE;
    const bass = sine(60, n, 0.5);
    const guitar = sine(660, n, 0.3);
    const { audio } = reduceVoice([bass.map((v, i) => v + guitar[i]!), Float32Array.from(bass)], RATE);
    let c = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      c += audio[0][i]! * Math.cos((2 * Math.PI * 60 * i) / RATE);
      s += audio[0][i]! * Math.sin((2 * Math.PI * 60 * i) / RATE);
    }
    expect(Math.hypot(c, s) / n).toBeGreaterThan(0.1);
  });
});
