// Runs the desktop's own JUCE frontend library (extern/local-mic-effects/ui/juce/index.js)
// against JuceBackend, so the protocol is checked against the real thing.
import { beforeAll, describe, expect, it } from "vitest";
import { JuceBackend, type ParameterInfo } from "../src/backend";

const parameters: Record<string, ParameterInfo> = {
  inputGain: { name: "Input Gain", min: -24, max: 24, skew: 1, step: 0.1, label: "dB", default: 0 },
  reverbOn: { name: "Reverb On", min: 0, max: 1, skew: 1, step: 1, label: "", default: 1, bool: true },
  tuneKey: { name: "Autotune Key", min: 0, max: 11, skew: 1, step: 1, label: "", default: 0, choices: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] },
};

const changes: [string, number][] = [];
const missing: string[] = [];
const backend = new JuceBackend({
  parameters,
  functions: {
    add: (a: number, b: number) => a + b,
    later: async () => ({ ok: true }),
    broken: () => {
      throw new Error("nope");
    },
  },
  onParameterChanged: (id, value) => changes.push([id, value]),
  onMissingFunction: (name) => missing.push(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Juce: any;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  backend.install(globalThis as unknown as Window);
  Juce = await import("../../../extern/local-mic-effects/ui/juce/index.js");
});

describe("JuceBackend with the desktop's juce/index.js", () => {
  it("calls native functions and returns their results", async () => {
    expect(await Juce.getNativeFunction("add")(2, 3)).toBe(5);
    expect(await Juce.getNativeFunction("later")()).toEqual({ ok: true });
    expect(await Juce.getNativeFunction("broken")()).toEqual({ ok: false, error: "nope" });
    expect(await Juce.getNativeFunction("unknownThing")()).toBeNull();
    expect(missing).toContain("unknownThing");
  });

  it("gives sliders their range and value, and takes the page's changes", async () => {
    const slider = Juce.getSliderState("inputGain");
    await settle();
    expect(slider.properties).toMatchObject({ start: -24, end: 24, label: "dB", name: "Input Gain", parameterIndex: 0 });
    expect(slider.getScaledValue()).toBe(0);

    slider.setNormalisedValue(0.75); // -24 + 0.75 * 48 = 12
    await settle();
    expect(backend.getParameter("inputGain")).toBe(12);
    expect(changes).toContainEqual(["inputGain", 12]);

    backend.setParameter("inputGain", -6.04); // snapped to the 0.1 step
    expect(slider.getScaledValue()).toBeCloseTo(-6);
  });

  it("drives toggles and combo boxes", async () => {
    const toggle = Juce.getToggleState("reverbOn");
    const combo = Juce.getComboBoxState("tuneKey");
    await settle();
    expect(toggle.getValue()).toBe(true);
    expect(combo.properties.choices).toHaveLength(12);
    expect(combo.getChoiceIndex()).toBe(0);

    toggle.setValue(false);
    combo.setChoiceIndex(9);
    await settle();
    expect(backend.getParameter("reverbOn")).toBe(0);
    expect(backend.getParameter("tuneKey")).toBe(9);

    backend.setParameter("tuneKey", 2);
    expect(combo.getChoiceIndex()).toBe(2);
  });

  it("sends events to the page", () => {
    const seen: unknown[] = [];
    (globalThis as unknown as { __JUCE__: { backend: { addEventListener: (id: string, fn: (p: unknown) => void) => void } } }).__JUCE__.backend.addEventListener(
      "meters",
      (payload) => seen.push(payload),
    );
    backend.emit("meters", { input: -12 });
    expect(seen).toEqual([{ input: -12 }]);
  });
});
