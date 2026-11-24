import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { instantiateEngineModule, type EngineRuntime, type LiveEngine } from "../src/engine";

const RATE = 48000;
const BLOCK = 128;
const LIMIT = 10 ** (-1 / 20); // the -1 dB safety limiter

let runtime: EngineRuntime;

beforeAll(() => {
  const bytes = readFileSync(fileURLToPath(new URL("../dist/engine.wasm", import.meta.url)));
  runtime = instantiateEngineModule(new WebAssembly.Module(bytes));
});

// A sung "ah" at about 220 Hz: harmonics, a slow vibrato and a little breath noise.
function voice(seconds: number, level = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  let seed = 1;
  for (let i = 0; i < out.length; ++i) {
    const f = 220 * (1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / RATE));
    phase += (2 * Math.PI * f) / RATE;
    let s = 0;
    for (let h = 1; h <= 8; ++h) s += Math.sin(phase * h) / h;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = level * (0.5 * s + 0.02 * (seed / 2 ** 32 - 0.5));
  }
  return out;
}

function run(engine: LiveEngine, input: Float32Array) {
  const left = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let at = 0; at + BLOCK <= input.length; at += BLOCK) {
    engine.render(input.subarray(at, at + BLOCK), l, r);
    left.set(l, at);
    right.set(r, at);
  }
  return { left, right };
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const allFinite = (x: Float32Array) => x.every(Number.isFinite);

describe("LiveEngine (desktop DSP in wasm)", () => {
  it("lists the desktop parameter IDs with their defaults", () => {
    const engine = runtime.create(RATE, BLOCK);
    const info = engine.valueInfo();
    const ids = info.map((v) => v.id);
    for (const id of ["hpfOn", "tuneOn", "tuneSpeed", "reverbOn", "reverbMix", "harmonyOn", "inputGain", "outputGain"])
      expect(ids).toContain(id);
    expect(info.every((v) => Number.isFinite(v.defaultValue))).toBe(true);
    expect(info.find((v) => v.id === "reverbOn")).toMatchObject({ isSwitch: true, module: "reverb" });
    expect(info.find((v) => v.id === "harmonyOn")?.module).toBe("pitch");
    engine.dispose();
  });

  it("sets and reads values, and rejects unknown IDs", () => {
    const engine = runtime.create(RATE, BLOCK);
    expect(engine.setValue("reverbMix", 42)).toBe(true);
    expect(engine.getValue("reverbMix")).toBeCloseTo(42);
    expect(engine.setValue("noSuchValue", 1)).toBe(false);
    expect(engine.getValue("noSuchValue")).toBeUndefined();
    expect(engine.setValue("outputGain", -6)).toBe(true);
    expect(engine.getValue("outputGain")).toBe(-6);
    engine.resetValues();
    const reverbMix = engine.valueInfo().find((v) => v.id === "reverbMix")!.defaultValue;
    expect(engine.getValue("reverbMix")).toBeCloseTo(reverbMix);
    engine.dispose();
  });

  it("keeps the effects' order like the desktop app", () => {
    const engine = runtime.create(RATE, BLOCK);
    const standard = engine.getOrder();
    expect(standard[0]).toBe("highPass");
    expect(standard.length).toBeGreaterThan(30);

    engine.setOrder(["reverb", "echo"]); // a short list goes first, the rest keep their order
    const order = engine.getOrder();
    expect(order.slice(0, 2)).toEqual(["reverb", "echo"]);
    expect(order.length).toBe(standard.length);
    expect([...order].sort()).toEqual([...standard].sort());
    engine.dispose();
  });

  // The desktop's safety limiter (juce::dsp::Limiter) has a built-in make-up gain, so even
  // with every effect off the output isn't the input. Hold-for-dry takes the same gain path
  // without the effects, so "all off" must match it sample for sample.
  it("with every effect off, sounds the same as hold-for-dry", () => {
    const off = runtime.create(RATE, BLOCK);
    for (const v of off.valueInfo()) if (v.isSwitch) off.setValue(v.id, 0);
    const dry = runtime.create(RATE, BLOCK);
    dry.setValue("reverbOn", 1);
    dry.setValue("tuneOn", 1);
    dry.setValue("dryCompare", 1);

    const input = voice(0.5);
    const a = run(off, input).left;
    const b = run(dry, input).left;
    // After the reverb and plate (which keep running for their tails) have faded out.
    let maxDiff = 0;
    for (let i = RATE / 4; i < input.length; ++i) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeLessThan(1e-4);
    expect(peak(b)).toBeGreaterThan(0.1);
    off.dispose();
    dry.dispose();
  });

  it("runs every effect at once without NaN, and the limiter holds -1 dB", () => {
    const engine = runtime.create(RATE, BLOCK);
    for (const v of engine.valueInfo()) if (v.isSwitch) engine.setValue(v.id, 1);
    engine.setValue("inputGain", 18); // drive it hard
    const { left, right } = run(engine, voice(2, 0.9));
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(Math.max(peak(left), peak(right))).toBeLessThanOrEqual(LIMIT + 0.02);
    engine.dispose();
  });

  it("changes the sound when an effect is on", () => {
    const engine = runtime.create(RATE, BLOCK);
    for (const v of engine.valueInfo()) if (v.isSwitch) engine.setValue(v.id, 0);
    const input = voice(0.5);
    const before = run(engine, input).left;
    engine.setValue("robotOn", 1);
    const after = run(engine, input).left;
    let maxDiff = 0;
    for (let i = 0; i < input.length; ++i) maxDiff = Math.max(maxDiff, Math.abs(after[i]! - before[i]!));
    expect(maxDiff).toBeGreaterThan(0.05);
    engine.dispose();
  });

  it("reports meters and the autotune's latency", () => {
    const engine = runtime.create(RATE, BLOCK);
    engine.setValue("tuneOn", 1);
    run(engine, voice(0.5));
    const meters = engine.takeMeters();
    expect(meters.input).toBeGreaterThan(0.1);
    expect(meters.output).toBeGreaterThan(0.05);
    expect(meters.latencySamples).toBeGreaterThan(0);
    expect(engine.takeMeters().input).toBe(0); // reset on read
    engine.dispose();
  });

  it("runs a typical vocal chain well within real time", () => {
    const engine = runtime.create(RATE, BLOCK);
    for (const id of ["hpfOn", "denoiseOn", "gateOn", "tuneOn", "harmonyOn", "eqOn", "compOn", "deessOn", "delayOn", "reverbOn", "doublerOn", "chorusOn", "widthOn"])
      expect(engine.setValue(id, 1)).toBe(true);
    const input = voice(5);
    const start = performance.now();
    run(engine, input);
    const share = (performance.now() - start) / 5000;
    console.log(`13 effects: ${(share * 100).toFixed(1)}% of real time`);
    expect(share).toBeLessThan(0.5);
    engine.dispose();
  });

  it("has the desktop's parameter list, ranges and defaults", () => {
    const engine = runtime.create(RATE, BLOCK);
    const info = engine.parameterInfo();
    const ids = Object.keys(info);
    expect(ids[0]).toBe("inputGain");
    expect(ids.length).toBeGreaterThan(250);
    expect(info.tuneKey?.choices).toHaveLength(12);
    expect(info.hpfOn).toMatchObject({ bool: true, default: 1 });
    expect(info.tuneSpeed).toMatchObject({ min: 0, max: 200, default: 20, label: "ms" });
    expect(info.tuneSpeed!.skew).not.toBe(1); // centred at 40 ms, like the desktop knob
    // The engine starts from these defaults.
    for (const id of ["hpfOn", "compOn", "reverbOn", "tuneSpeed", "reverbMix"]) expect(engine.getValue(id)).toBeCloseTo(info[id]!.default);
    engine.dispose();
  });

  it("has the desktop's factory presets", () => {
    const engine = runtime.create(RATE, BLOCK);
    const presets = engine.factoryPresets();
    expect(presets.length).toBeGreaterThanOrEqual(24);
    expect(presets[0]).toMatchObject({ name: "Natural", category: "Clean" });
    expect(presets.find((p) => p.name === "Podcast")?.values.denoiseOn).toBe(1);
    expect(new Set(presets.map((p) => p.category))).toEqual(new Set(["Clean", "Tuned", "Characters", "Lo-fi", "Space"]));
    engine.dispose();
  });

  it("loads a preset like the desktop: defaults, its values, the input gain kept", () => {
    const engine = runtime.create(RATE, BLOCK);
    const presets = engine.factoryPresets();
    engine.setValue("inputGain", 6);
    engine.setValue("robotOn", 1);
    expect(engine.loadPreset(presets.findIndex((p) => p.name === "Podcast"))).toBe(true);
    expect(engine.getValue("denoiseOn")).toBe(1);
    expect(engine.getValue("reverbOn")).toBe(0);
    expect(engine.getValue("compRatio")).toBeCloseTo(4);
    expect(engine.getValue("robotOn")).toBe(0); // back to its default
    expect(engine.getValue("inputGain")).toBe(6); // the mic's, not the preset's
    expect(engine.loadPreset(999)).toBe(false);
    engine.dispose();
  });

  it("renders every factory preset cleanly", () => {
    const input = voice(1, 0.5);
    runtime.create(RATE, BLOCK).factoryPresets().forEach((preset, index) => {
      const engine = runtime.create(RATE, BLOCK);
      engine.loadPreset(index);
      const { left, right } = run(engine, input);
      expect(allFinite(left) && allFinite(right), preset.name).toBe(true);
      expect(Math.max(peak(left), peak(right)), preset.name).toBeLessThanOrEqual(LIMIT + 0.02);
      expect(peak(left), preset.name).toBeGreaterThan(0.005);
      engine.dispose();
    });
  });

  // Switching while singing: the limiter has no look-ahead, so the first moment after a big
  // change can overshoot -1 dB (as on the desktop), but never past full scale.
  it("switches between every preset while singing without NaN or going past full scale", () => {
    const engine = runtime.create(RATE, BLOCK);
    const input = voice(0.5, 0.5);
    engine.factoryPresets().forEach((preset, index) => {
      engine.loadPreset(index);
      const { left, right } = run(engine, input);
      expect(allFinite(left) && allFinite(right), preset.name).toBe(true);
      expect(Math.max(peak(left), peak(right)), preset.name).toBeLessThanOrEqual(1);
    });
    engine.dispose();
  });

  it("reports the tuner and the effect cards' readings", () => {
    const engine = runtime.create(RATE, BLOCK);
    engine.setValue("tuneOn", 1);
    engine.setValue("compOn", 1);
    run(engine, voice(0.5));
    const status = engine.status();
    expect(status.note).toBeGreaterThan(55); // A3 = 57
    expect(status.note).toBeLessThan(59);
    expect(status.target).toBe(57);
    expect(Object.keys(status.fx)).toContain("compressor");
    expect(Object.keys(status.fx)).not.toContain("robot"); // off
    engine.dispose();
  });
});

describe("key detection", () => {
  // Chords of A minor (Am, Dm, E, Am), 2 s each, as sine triads.
  function song(): Float32Array {
    const chords = [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]];
    const out = new Float32Array(RATE * 2 * chords.length * 2);
    for (let i = 0; i < out.length; ++i) {
      const chord = chords[Math.floor(i / (RATE * 2)) % chords.length]!;
      let s = 0;
      for (const note of chord) {
        const f = 440 * 2 ** ((note - 69) / 12);
        s += Math.sin((2 * Math.PI * f * i) / RATE) + 0.5 * Math.sin((4 * Math.PI * f * i) / RATE);
      }
      out[i] = 0.1 * s;
    }
    return out;
  }

  it("finds A minor", () => {
    const engine = runtime.create(RATE, BLOCK);
    const started = performance.now();
    const key = engine.detectKey(song(), RATE);
    const ms = performance.now() - started;
    engine.dispose();
    expect(key.ok).toBe(true);
    expect([key.key, key.minor]).toEqual([9, true]);
    expect(key.name).toMatch(/^A/);
    console.log(`key: ${key.name} (${key.confidence.toFixed(2)}) in ${ms.toFixed(0)} ms for 16 s`);
  });

  it("says when there is no key", () => {
    const engine = runtime.create(RATE, BLOCK);
    const key = engine.detectKey(new Float32Array(RATE), RATE);
    engine.dispose();
    expect(key.ok).toBe(false);
  });
});
