import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Analysis, MIX_STYLES } from "../src/analysis";
import { instantiateEngineModule } from "../src/engine";

const RATE = 48000;
let analysis: Analysis;

beforeAll(() => {
  const bytes = readFileSync(fileURLToPath(new URL("../dist/analysis.wasm", import.meta.url)));
  analysis = new Analysis(new WebAssembly.Module(bytes));
});

// Phrases of a sung "ah" (about 2 s each) with pauses between them, over a little room noise
// and some low rumble: what a sound check hears.
function singing(seconds: number, level = 0.25, room = 0.004): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  let seed = 7;
  const notes = [220, 247, 262, 196, 233];
  for (let i = 0; i < out.length; ++i) {
    const t = i / RATE;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = room * (seed / 2 ** 32 - 0.5) + 0.002 * Math.sin(2 * Math.PI * 50 * t);
    const phrase = Math.floor(t / 3.2);
    const inPhrase = t % 3.2;
    let voice = 0;
    if (inPhrase < 2.0) {
      const f = notes[phrase % notes.length]! * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, inPhrase / 0.05, (2.0 - inPhrase) / 0.1);
      for (let h = 1; h <= 12; ++h) voice += Math.sin(phase * h) / (h * (h > 3 ? 1.5 : 1));
      voice *= level * env;
    }
    out[i] = voice + noise;
  }
  return out;
}

describe("analysis.wasm", () => {
  it("names the Auto Mix styles", () => {
    expect(analysis.styles()).toEqual(MIX_STYLES);
  });

  it("plans a Live chain for a voice, with the room's profile", () => {
    const started = performance.now();
    const plan = analysis.soundCheck(singing(15, 0.25, 0.02), RATE, { style: 0 });
    const took = performance.now() - started;
    expect(plan.error).toBe("");
    const ids = plan.values.map(([id]) => id);
    expect(ids).toContain("hpfOn");
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.peak).toBeLessThan(0);
    expect(plan.sung).toBeGreaterThan(8);
    expect(took).toBeLessThan(5000);

    // A noisy room: the denoiser comes on, and the Live engine's takes the room's profile.
    expect(plan.values).toContainEqual(["denoiseOn", 1]);
    expect(plan.noiseProfile.length).toBeGreaterThan(0);
    {
      const engine = instantiateEngineModule(
        new WebAssembly.Module(readFileSync(fileURLToPath(new URL("../dist/engine.wasm", import.meta.url)))),
      ).create(RATE);
      expect(engine.offerNoiseProfile(plan.noiseProfile)).toBe(true);
    }
  });

  it("fits only the levels of the chain there is", () => {
    const plan = analysis.soundCheck(singing(12, 0.05), RATE, {
      fit: { inputGainDb: 0, minInputDb: -24, maxInputDb: 24, gate: true, classicDeEsser: false, denoise: false, lowCutHz: 80 },
    });
    expect(plan.error).toBe("");
    const values = Object.fromEntries(plan.values);
    expect(values.inputGain).toBeGreaterThan(3); // a quiet voice is brought up
    expect(plan.changes.length).toBeGreaterThan(0);
  });

  it("refuses too little voice", () => {
    const plan = analysis.soundCheck(new Float32Array(RATE * 8), RATE, { style: 0 });
    expect(plan.error).not.toBe("");
    expect(plan.values).toEqual([]);
  });
});
