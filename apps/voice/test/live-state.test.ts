import { describe, expect, it } from "vitest";
import type { ParameterInfo } from "@micfx/bridge";
import { LiveHistory, Scenes, fromNormalised, toNormalised, type ParameterAccess } from "../src/live-state";

const info: Record<string, ParameterInfo> = {
  inputGain: { name: "Input Gain", min: -24, max: 24, skew: 1, step: 0.1, label: "dB", default: 0 },
  reverbOn: { name: "Reverb On", min: 0, max: 1, skew: 1, step: 1, label: "", default: 0, bool: true },
  reverbMix: { name: "Reverb Mix", min: 0, max: 100, skew: 1, step: 0, label: "%", default: 20 },
  cutoff: { name: "Cutoff", min: 20, max: 20000, skew: 0.25, step: 0, label: "Hz", default: 80 },
  style: { name: "Style", min: 0, max: 2, skew: 1, step: 1, label: "", default: 0, choices: ["Clean", "Punch", "Glue"] },
};

function makeParams(): ParameterAccess & { values: Record<string, number>; sets: string[] } {
  const values = Object.fromEntries(Object.entries(info).map(([id, p]) => [id, p.default]));
  const sets: string[] = [];
  return { ids: Object.keys(info), info, values, sets, get: (id) => values[id]!, set: (id, v) => { values[id] = v; sets.push(id); } };
}

describe("normalised values", () => {
  it("round-trip with skew, steps, switches and choices", () => {
    expect(toNormalised(info.cutoff!, 20000)).toBe(1);
    expect(fromNormalised(info.cutoff!, toNormalised(info.cutoff!, 440))).toBeCloseTo(440, 3);
    expect(toNormalised(info.cutoff!, 1000)).toBeCloseTo(Math.pow(980 / 19980, 0.25), 6);
    expect(fromNormalised(info.inputGain!, 0.5013)).toBe(0.1);
    expect(toNormalised(info.style!, 2)).toBe(1);
    expect(fromNormalised(info.style!, 0.4)).toBe(1);
    expect(fromNormalised(info.reverbOn!, 0.6)).toBe(1);
  });
});

describe("live history", () => {
  it("commits a change once it rests, and undoes and redoes it", () => {
    let now = 0;
    const params = makeParams();
    const history = new LiveHistory(params, () => now);
    let preset = 3;
    history.getPreset = () => preset;
    history.setPreset = (p) => (preset = p);
    history.start = () => {}; // no timer in tests

    params.values.reverbMix = 40;
    history.tick();
    now = 100;
    params.values.reverbMix = 60; // still dragging
    history.tick();
    now = 200;
    history.tick();
    expect(history.undoName).toBe(""); // not rested yet
    now = 600;
    history.tick();
    expect(history.undoName).toBe("Reverb Mix");

    history.label("Load preset Robot");
    params.values.reverbOn = 1;
    params.values.style = 2;
    preset = 7;
    history.flush();
    expect(history.undoName).toBe("Load preset Robot");

    expect(history.undo()).toBe(true);
    expect([params.values.reverbOn, params.values.style, preset]).toEqual([0, 0, 3]);
    expect(history.redoName).toBe("Load preset Robot");
    expect(history.undo()).toBe(true);
    expect(params.values.reverbMix).toBe(20);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(params.values.reverbMix).toBe(60);

    params.values.cutoff = 200; // a new change forgets the redo
    history.flush();
    expect(history.redoName).toBe("");
  });

  it("holds changes into one step", () => {
    const params = makeParams();
    const history = new LiveHistory(params, () => 0);
    history.hold("Sound check");
    params.values.reverbMix = 50;
    history.flush();
    params.values.cutoff = 300;
    history.flush();
    expect(history.undoName).toBe("");
    history.release();
    expect(history.undoName).toBe("Sound check");
  });
});

describe("scenes", () => {
  it("saves, glides back, and switches effects at the right moment", () => {
    let now = 0;
    const params = makeParams();
    const scenes = new Scenes(params, () => now);
    params.values.inputGain = 6;
    scenes.add("Verse");
    params.values.reverbOn = 1;
    params.values.reverbMix = 80;
    params.values.style = 2;
    scenes.add("");
    expect(scenes.describe().scenes.map((s) => s.name)).toEqual(["Verse", "Scene 2"]);
    expect(scenes.describe().active).toBe(1);

    params.values.inputGain = -3; // the mic's level isn't part of a scene
    scenes.handle("glide", { seconds: 1 });
    scenes.recall(0);
    expect(params.values.style).toBe(0); // choices: at once
    expect(params.values.reverbOn).toBe(1); // an effect going off waits for the end
    expect(scenes.gliding).toBe(true);
    scenes.advance(0.5);
    expect(params.values.reverbMix).toBeCloseTo(50, 5); // eased, half way
    scenes.advance(0.6);
    expect(params.values.reverbMix).toBe(20);
    expect(params.values.reverbOn).toBe(0);
    expect(params.values.inputGain).toBe(-3);
    expect(scenes.gliding).toBe(false);
    expect(scenes.describe().modified).toBe(false);

    params.values.reverbMix = 30;
    expect(scenes.describe().modified).toBe(true);
    scenes.step(1);
    scenes.advance(2);
    expect(scenes.describe().active).toBe(1);
    expect(params.values.reverbMix).toBe(80);

    const saved = scenes.save();
    const again = new Scenes(params);
    again.restore(JSON.parse(JSON.stringify(saved)));
    expect(again.describe()).toMatchObject({ active: 1, glide: 1, scenes: [{ name: "Verse" }, { name: "Scene 2" }] });

    scenes.remove(0);
    expect(scenes.describe().active).toBe(0);
  });

  it("keeps at most 8", () => {
    const scenes = new Scenes(makeParams());
    for (let i = 0; i < 8; ++i) expect(scenes.add()).toBe(i);
    expect(scenes.add()).toBe(-1);
  });
});
