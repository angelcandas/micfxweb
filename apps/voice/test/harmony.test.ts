import { describe, expect, it } from "vitest";
import { historyFile, parseKey, partMelody, thirdOf } from "../src/harmony";

describe("duet harmony", () => {
  it("reads the song's key", () => {
    expect(parseKey("G major")).toEqual({ tonic: 7, scale: [0, 2, 4, 5, 7, 9, 11] });
    expect(parseKey("F♯ minor")?.tonic).toBe(6);
    expect(parseKey("Bb major")?.tonic).toBe(10);
    expect(parseKey("unknown")).toBeUndefined();
  });
  it("moves each note a third within the key", () => {
    const g = parseKey("G major")!;
    expect(thirdOf(67, g, 1)).toBe(71); // G → B (major third)
    expect(thirdOf(69, g, 1)).toBe(72); // A → C (minor third)
    expect(thirdOf(71, g, -1)).toBe(67); // B → G
    expect(thirdOf(66, g, 1)).toBe(69); // F♯ → A
    expect(thirdOf(67.2, g, 1)).toBeCloseTo(71.2); // the cents stay
    expect(thirdOf(70, g, 1)).toBe(73); // B♭ (outside the key) moves with A → C♯
    const a = parseKey("A minor")!;
    expect(thirdOf(57, a, 1)).toBe(60); // A → C
    expect(thirdOf(64, a, 1)).toBe(67); // E → G
  });
  it("rewrites the melody text for a part, and keeps the lead as it is", () => {
    const melody = "0.500 1.000 67.00\n1.200 2.000 69.00\n";
    expect(partMelody(melody, "G major", "above")).toBe("0.500 1.000 71.00\n1.200 2.000 72.00\n");
    expect(partMelody(melody, "G major", "below")).toBe("0.500 1.000 64.00\n1.200 2.000 66.00\n");
    expect(partMelody(melody, "G major", "lead")).toBe(melody);
    expect(historyFile("lead")).toBe("history.json");
    expect(historyFile("above")).toBe("history-above.json");
  });
});
