import { describe, expect, it } from "vitest";
import { tipName } from "../src/a11y";

describe("names from tooltips", () => {
  it("keeps the first line without its shortcut", () => {
    expect(tipName("Previous preset (Ctrl+←)")).toBe("Previous preset");
    expect(tipName("Record your voice (R)\nOn a new track")).toBe("Record your voice");
    expect(tipName("Presets for this effect")).toBe("Presets for this effect");
    expect(tipName("Tempo in beats per minute (the looper's tempo too)")).toBe("Tempo in beats per minute (the looper's tempo too)");
  });
});
