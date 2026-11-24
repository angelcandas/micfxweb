import { describe, expect, it } from "vitest";
import type { ParameterInfo } from "@micfx/bridge";
import type { ParameterAccess } from "../src/live-state";
import { MidiMap, describeSource, parseMidi } from "../src/midi-map";

const info: Record<string, ParameterInfo> = {
  reverbOn: { name: "Reverb On", min: 0, max: 1, skew: 1, step: 1, label: "", default: 0, bool: true },
  reverbMix: { name: "Reverb Mix", min: 0, max: 100, skew: 1, step: 0, label: "%", default: 50 },
  style: { name: "Style", min: 0, max: 2, skew: 1, step: 1, label: "", default: 0, choices: ["Clean", "Punch", "Glue"] },
};

function setup() {
  const values: Record<string, number> = Object.fromEntries(Object.entries(info).map(([id, p]) => [id, p.default]));
  const params: ParameterAccess = { ids: Object.keys(info), info, get: (id) => values[id]!, set: (id, v) => (values[id] = v) };
  return { values, map: new MidiMap(params) };
}

const cc = (number: number, value: number, channel = 1) => [0xb0 + channel - 1, number, value];
const note = (number: number, velocity = 100, channel = 1) => [0x90 + channel - 1, number, velocity];

describe("MIDI learn", () => {
  it("names and parses sources as the desktop does", () => {
    expect(describeSource({ source: "cc", channel: 1, number: 64 })).toBe("CC 64 · ch 1");
    expect(describeSource({ source: "note", channel: 2, number: 60 })).toBe("Note C3 · ch 2");
    expect(describeSource({ source: "program", channel: 1, number: 4 })).toBe("Program 5 · ch 1");
    expect(parseMidi(note(60, 0))).toBeUndefined(); // note off
    expect(parseMidi([0xc3, 7])).toEqual({ source: "program", channel: 4, number: 7, value: 0 });
  });

  it("learns the next message, replacing what the source or target had", () => {
    const { map } = setup();
    let learned = "";
    map.onLearned = (m) => (learned = m.target);
    map.learning = "param:reverbOn";
    map.receive(cc(64, 127));
    expect(learned).toBe("param:reverbOn");
    expect(map.learning).toBe("");
    map.learning = "param:reverbOn";
    map.receive(note(36));
    expect(map.describe().map((m) => m.name)).toEqual(["Note C1 · ch 1"]);
  });

  it("a pedal flips a switch when it crosses 64 upwards", () => {
    const { map, values } = setup();
    map.setMappings([{ source: "cc", channel: 1, number: 64, target: "param:reverbOn" }]);
    map.receive(cc(64, 127));
    expect(values.reverbOn).toBe(1);
    map.receive(cc(64, 120)); // still down
    expect(values.reverbOn).toBe(1);
    map.receive(cc(64, 0));
    map.receive(cc(64, 127));
    expect(values.reverbOn).toBe(0);
  });

  it("a knob picks up before it moves the value", () => {
    const { map, values } = setup();
    map.setMappings([{ source: "cc", channel: 1, number: 7, target: "param:reverbMix" }]);
    map.receive(cc(7, 10)); // far from 50%: nothing
    expect(values.reverbMix).toBe(50);
    map.receive(cc(7, 90)); // passed the value: picked up
    expect(values.reverbMix).toBeCloseTo((90 / 127) * 100, 3);
    map.receive(cc(7, 127));
    expect(values.reverbMix).toBe(100);
  });

  it("choices follow a knob or step on a key; actions run on a press", () => {
    const { map, values } = setup();
    const steps: number[] = [];
    const actions: string[] = [];
    map.onPresetStep = (d) => steps.push(d);
    map.onAction = (a) => actions.push(a);
    map.setMappings([
      { source: "cc", channel: 1, number: 1, target: "param:style" },
      { source: "note", channel: 1, number: 40, target: "param:style" },
      { source: "program", channel: 1, number: 3, target: "action:preset.next" },
      { source: "note", channel: 2, number: 41, target: "action:record" },
    ]);
    map.receive(cc(1, 127));
    expect(values.style).toBe(2);
    map.receive(note(40));
    expect(values.style).toBe(0);
    map.receive([0xc0, 3]);
    map.receive(note(41, 100, 2));
    expect(steps).toEqual([1]);
    expect(actions).toEqual(["record"]);
    expect(map.eventCount).toBe(4);
  });
});
