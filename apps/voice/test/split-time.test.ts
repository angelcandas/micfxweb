import { describe, expect, it } from "vitest";
import { splitSecondsLeft } from "../src/practice";
import { durationText } from "../src/practice-tools";

describe("split time", () => {
  it("guesses before the split from the last one here, or from the cores", () => {
    expect(splitSecondsLeft({ seconds: 200, progress: 0, elapsed: 0 }, 0.5)).toBe(400);
    expect(splitSecondsLeft({ seconds: 200, progress: 0, elapsed: 0 }, undefined, 8)).toBe(500);
    expect(splitSecondsLeft({ seconds: 200, progress: 0, elapsed: 0 }, undefined, 2)).toBe(1000);
  });
  it("goes by how far it has got once it's under way", () => {
    expect(splitSecondsLeft({ seconds: 200, progress: 0.25, elapsed: 60 }, 0.5)).toBe(180);
  });
  it("says it in words", () => {
    expect(durationText(30)).toBe("under a minute");
    expect(durationText(70)).toBe("about a minute");
    expect(durationText(400)).toBe("about 7 min");
  });
});
