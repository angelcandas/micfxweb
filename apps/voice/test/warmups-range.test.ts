import { describe, expect, it } from "vitest";
import { heldNote, spanText, suggestShift } from "../src/range";
import { EXERCISES, makeWarmup, noteName, renderBacking, renderGuide, rootFor } from "../src/warmups";

describe("range finder", () => {
  it("finds the held note, not the scoop into it or the crack after", () => {
    const readings = [0, 0, 50, 52, 54, ...Array(30).fill(57).map((m, i) => m + (i % 3) * 0.1), 0, 64, 0];
    expect(heldNote(readings)).toBeCloseTo(57.1, 1);
    expect(heldNote([0, 60, 0, 61, 0])).toBeUndefined();
  });
  it("suggests the key that puts a song inside the range", () => {
    // A song from C4 to E5 (60..76) for a voice from G2 to E4 (43..64): as far down as allowed.
    expect(suggestShift({ lowest: 60, highest: 76 }, { low: 43, high: 64 })).toBe(-6);
    // It fits already, centred: no change.
    expect(suggestShift({ lowest: 55, highest: 67 }, { low: 50, high: 72 })).toBe(0);
    // Two semitones too high.
    expect(suggestShift({ lowest: 52, highest: 66 }, { low: 45, high: 64 })).toBe(-2);
  });
  it("says a span in words", () => {
    expect(spanText(16)).toBe("1 octave and 4 semitones");
    expect(spanText(24)).toBe("2 octaves");
    expect(spanText(1)).toBe("1 semitone");
  });
});

describe("warm-ups", () => {
  it("goes round a semitone higher each time, with the melody Practice reads", () => {
    const warmup = makeWarmup({ exercise: "five", root: 48, rounds: 3, tempo: "medium" });
    expect(warmup.name).toBe("Five-note scale from C3");
    expect(warmup.notes).toHaveLength(27);
    expect(warmup.notes[0]!.midi).toBe(48);
    expect(warmup.notes[9]!.midi).toBe(49);
    expect(warmup.notes[22]!.midi).toBe(50 + 7);
    expect(warmup.rounds.map((r) => r.root)).toEqual([48, 49, 50]);
    const lines = warmup.melody.trim().split("\n");
    expect(lines).toHaveLength(27);
    expect(lines[0]).toMatch(/^\d+\.\d{3} \d+\.\d{3} 48\.00$/);
    // Notes never overlap, and the rounds have a breath between them.
    for (let i = 1; i < warmup.notes.length; ++i) expect(warmup.notes[i]!.start).toBeGreaterThanOrEqual(warmup.notes[i - 1]!.end);
  });
  it("starts inside the singer's range", () => {
    const five = EXERCISES[0]!;
    expect(rootFor(five, 4, { low: 45, high: 64 })).toBe(47);
    // A narrow range: the top round still fits.
    expect(rootFor(five, 4, { low: 50, high: 62 })).toBe(52);
    expect(rootFor(five, 4, undefined)).toBe(55);
    expect(noteName(55)).toBe("G3");
  });
  it("renders a guide that sounds where the notes are, and a chord per round", () => {
    const warmup = makeWarmup({ exercise: "arpeggio", root: 55, rounds: 2, tempo: "fast" });
    const rate = 8000;
    const guide = renderGuide(warmup, rate);
    const loud = (from: number, to: number) => Math.max(...guide.subarray(Math.round(from * rate), Math.round(to * rate)).map(Math.abs));
    const first = warmup.notes[0]!;
    expect(loud(first.start + 0.1, first.end - 0.1)).toBeGreaterThan(0.1);
    expect(loud(0, first.start - 0.05)).toBe(0);
    const [left] = renderBacking(warmup, rate);
    expect(Math.max(...left.subarray(0, rate).map(Math.abs))).toBeGreaterThan(0.01);
  });
});
