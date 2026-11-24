import { describe, expect, it } from "vitest";
import type { ParameterInfo } from "@micfx/bridge";
import type { SoundCheckPlan } from "@micfx/engine/analysis";
import type { ParameterAccess } from "../src/live-state";
import { SoundCheck } from "../src/sound-check";

const RATE = 1000; // small buffers: 0.1 s is 100 samples
const info: Record<string, ParameterInfo> = {
  inputGain: { name: "Input Gain", min: -24, max: 24, skew: 1, step: 0.1, label: "dB", default: 0 },
  hpfOn: { name: "High-pass On", min: 0, max: 1, skew: 1, step: 1, label: "", default: 0, bool: true },
  gateThreshold: { name: "Gate Threshold", min: -80, max: 0, skew: 1, step: 0, label: "dB", default: -55 },
};

function setup(plan: Partial<SoundCheckPlan> = {}) {
  const values: Record<string, number> = { inputGain: 0, hpfOn: 0, gateThreshold: -55 };
  const params: ParameterAccess = { ids: Object.keys(info), info, get: (id) => values[id]!, set: (id, v) => (values[id] = v) };
  let now = 0;
  const events: string[] = [];
  const scenes: string[] = [];
  let listening = false;
  let planned: { mono: Float32Array; options: unknown } | undefined;
  const profiles: Float32Array[] = [];
  const check = new SoundCheck({
    params,
    listen: (on) => ((listening = on), true),
    plan: async (mono, _rate, options) => {
      planned = { mono, options };
      return { error: "", values: [["hpfOn", 1], ["gateThreshold", -40]], changes: [{ module: "High-pass", text: "On" }], notes: [], advice: "", peak: -6, lufs: -20, noise: -60, sung: 8, noiseProfile: new Float32Array([1, 2]), ...plan };
    },
    offerNoiseProfile: async (bins) => (profiles.push(bins), true),
    addScene: (name) => (scenes.length >= 8 ? -1 : scenes.push(name) - 1),
    sceneName: (i) => scenes[i] ?? "",
    onChange: (state) => events.push(state.phase),
    now: () => now,
  });
  check.prepare(RATE);
  const sing = (seconds: number, level = 0.3) => {
    for (let i = 0; i < seconds * 10; ++i) {
      check.capture(new Float32Array(100).fill(level));
      now += 100;
      check.tick();
    }
  };
  return { check, values, sing, events, scenes, profiles, isListening: () => listening, planned: () => planned, advance: (ms: number) => (now += ms) };
}

const settle = () => new Promise((r) => setTimeout(r));

describe("sound check", () => {
  it("listens, plans, applies, and compares with the sound from before", async () => {
    const t = setup();
    const started = await t.check.handle("start", { seconds: 6, style: 2 });
    expect(started.phase).toBe("listening");
    expect(started.style).toBe(2);
    expect(t.isListening()).toBe(true);

    t.sing(3);
    let state = t.check.describe();
    expect(state.voiceSeconds).toBeCloseTo(3, 1);
    expect(state.canFinish).toBe(false);
    t.sing(3); // reaches the 6 s target
    await settle();
    expect(t.isListening()).toBe(false);
    expect(t.planned()?.mono.length).toBe(6000);
    expect(t.planned()?.options).toEqual({ style: 2 });

    state = t.check.describe();
    expect(state.phase).toBe("done");
    expect(state.comparing).toBe("after");
    expect(t.values).toMatchObject({ hpfOn: 1, gateThreshold: -40 });
    expect(t.profiles).toHaveLength(1);

    await t.check.handle("compare", { after: false });
    expect(t.values).toMatchObject({ hpfOn: 0, gateThreshold: -55 });
    const kept = await t.check.handle("saveScene", { name: "Room A" });
    expect(kept.phase).toBe("idle");
    expect(kept.scene).toBe("Room A");
    expect(t.values).toMatchObject({ hpfOn: 1, gateThreshold: -40 }); // keeping means the new sound
  });

  it("finishes early, fits the levels of the chain there is, and reverts", async () => {
    const t = setup();
    t.values.gateThreshold = -50;
    await t.check.handle("start", { seconds: 20, fit: true });
    t.sing(5);
    expect(t.check.describe().canFinish).toBe(true);
    await t.check.handle("finish");
    t.check.tick();
    await settle();
    expect(t.planned()?.mono.length).toBe(5000);
    expect(t.planned()?.options).toMatchObject({ fit: { gate: false, inputGainDb: 0, lowCutHz: 0 } });
    expect(t.check.describe().phase).toBe("done");
    await t.check.handle("revert");
    expect(t.values).toMatchObject({ hpfOn: 0, gateThreshold: -50 });
  });

  it("stops when no sound comes in, and reports the planner's refusal", async () => {
    const t = setup();
    await t.check.handle("start");
    t.sing(1);
    for (let i = 0; i < 25; ++i) {
      t.advance(100);
      t.check.tick();
    }
    expect(t.check.describe()).toMatchObject({ phase: "idle", error: expect.stringContaining("No sound") });

    const refused = setup({ error: "Too little voice: sing for at least 4 seconds." });
    await refused.check.handle("start", { seconds: 6 });
    refused.sing(6);
    await settle();
    expect(refused.check.describe()).toMatchObject({ phase: "idle", error: expect.stringContaining("Too little voice") });
    expect(refused.values.hpfOn).toBe(0);
  });
});
