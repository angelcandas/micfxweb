import { describe, expect, it } from "vitest";
import { Calibrator, measureRoundTrip } from "../src/calibration";

const RATE = 48000;
const BLOCK = 128;

/** Runs a calibration through a fake room: the output comes back `delay` frames later, quieter, with noise and an echo. */
function calibrate(delay: number, gain: number, noise: number) {
  const calibrator = new Calibrator(RATE);
  // What the mic hears, by absolute frame (grown as needed): no array shifting, so it's quick.
  let heard = new Float32Array(1 << 18);
  const add = (at: number, v: number) => {
    if (at >= heard.length) {
      const bigger = new Float32Array(heard.length * 2);
      bigger.set(heard);
      heard = bigger;
    }
    heard[at]! += v;
  };
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let now = 0; !calibrator.done; now += BLOCK) {
    const mic = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; ++i) mic[i] = (heard[now + i] ?? 0) + noise * random();
    const left = new Float32Array(BLOCK).fill(0.3); // the effects: replaced by the clicks
    const right = new Float32Array(BLOCK);
    calibrator.process(left, right, mic, BLOCK);
    for (let i = 0; i < BLOCK; ++i) {
      add(now + delay + i, gain * left[i]!);
      add(now + delay + 2400 + i, 0.8 * gain * left[i]!); // a wall 50 ms later
    }
  }
  return calibrator.result();
}

describe("latency calibration", () => {
  it("measures the round trip through a quiet room, ignoring the echo", () => {
    const { mic, clicks } = calibrate(2400, 0.2, 0.002); // 50 ms
    const trip = measureRoundTrip(mic, clicks, RATE);
    expect(trip.frames).toBe(2400);
    expect(trip.confidence).toBeGreaterThan(0.9);
  });

  it("measures a Bluetooth-long round trip in some noise", () => {
    const { mic, clicks } = calibrate(12000, 0.05, 0.01); // 250 ms
    expect(measureRoundTrip(mic, clicks, RATE).frames).toBe(12000);
  }, 30_000); // under a second alone, but CI runs it beside the wasm tests

  it("says so when the clicks aren't heard (headphones on)", () => {
    const { mic, clicks } = calibrate(2400, 0, 0.01);
    const trip = measureRoundTrip(mic, clicks, RATE);
    expect(trip.frames).toBeUndefined();
    expect(trip.confidence).toBeLessThan(0.5);
  });
});
