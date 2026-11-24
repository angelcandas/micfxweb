import { describe, expect, it } from "vitest";
import { Calibrator, measureRoundTrip } from "../src/calibration";

const RATE = 48000;
const BLOCK = 128;

/** Runs a calibration through a fake room: the output comes back `delay` frames later, quieter, with noise and an echo. */
function calibrate(delay: number, gain: number, noise: number) {
  const calibrator = new Calibrator(RATE);
  const line: number[] = new Array(delay + 4000).fill(0);
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  while (!calibrator.done) {
    const mic = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; ++i) mic[i] = line.shift()! + noise * random();
    const left = new Float32Array(BLOCK).fill(0.3); // the effects: replaced by the clicks
    const right = new Float32Array(BLOCK);
    calibrator.process(left, right, mic, BLOCK);
    for (let i = 0; i < BLOCK; ++i) {
      line[delay - BLOCK + i] = (line[delay - BLOCK + i] ?? 0) + gain * left[i]!;
      line[delay - BLOCK + 2400 + i] = (line[delay - BLOCK + 2400 + i] ?? 0) + 0.8 * gain * left[i]!; // a wall 50 ms later
      line.push(0);
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
  });

  it("says so when the clicks aren't heard (headphones on)", () => {
    const { mic, clicks } = calibrate(2400, 0, 0.01);
    const trip = measureRoundTrip(mic, clicks, RATE);
    expect(trip.frames).toBeUndefined();
    expect(trip.confidence).toBeLessThan(0.5);
  });
});
