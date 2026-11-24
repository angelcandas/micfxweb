import { describe, expect, it } from "vitest";
import { addPass, chartPoints, parsePasses, passFrom, progress, type Pass } from "../src/practice-history";

const DAY = 24 * 3600 * 1000;
const pass = (at: number, score: number): Pass => ({ at, score, pitch: 0.5, timing: 0.5, steady: 0.5, scored: 5, total: 5, speed: 1, semitones: 0 });

describe("practice progress", () => {
  it("keeps whole passes only", () => {
    expect(passFrom({ score: 71.26, pitch: 0.7, timing: 0.8, steady: 0.6, scored: 4, total: 5 }, 1, { speed: 1, semitones: 2 })).toMatchObject({ score: 71.3, scored: 4, semitones: 2 });
    expect(passFrom({ score: 80, scored: 2, total: 5, looping: true }, 1, { speed: 1, semitones: 0 })).toBeUndefined();
    expect(passFrom({ score: 0, scored: 0, total: 5 }, 1, { speed: 1, semitones: 0 })).toBeUndefined();
  });
  it("finds the best this week, the best ever and the trend", () => {
    const now = 100 * DAY;
    const passes = [pass(now - 20 * DAY, 90), pass(now - 3 * DAY, 60), pass(now - 2 * DAY, 64), pass(now - DAY, 70), pass(now, 80)];
    expect(progress(passes, now)).toEqual({ count: 5, best: 90, bestWeek: 80, weekCount: 4, trend: 80 - (90 + 60 + 64 + 70) / 4 });
    expect(progress([], now)).toEqual({ count: 0, best: undefined, bestWeek: undefined, weekCount: 0, trend: undefined });
  });
  it("keeps the last 300 and reads back what it wrote", () => {
    let passes: Pass[] = [];
    for (let i = 0; i < 305; ++i) passes = addPass(passes, pass(i, 50));
    expect(passes).toHaveLength(300);
    expect(passes[0]!.at).toBe(5);
    expect(parsePasses(JSON.stringify(passes))).toHaveLength(300);
    expect(parsePasses("not json")).toEqual([]);
  });
  it("charts scores from the bottom (0) to the top (100)", () => {
    expect(chartPoints([pass(0, 0), pass(1, 100)], 300, 60)).toEqual([[0, 60], [300, 0]]);
    expect(chartPoints([pass(0, 50)], 300, 60)).toEqual([[150, 30]]);
  });
});
