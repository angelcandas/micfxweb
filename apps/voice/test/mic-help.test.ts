import { describe, expect, it } from "vitest";
import { browserKind, micHelp } from "../src/mic-help";

describe("microphone help", () => {
  it("knows the browser from its user agent", () => {
    const cases: [string, number, string][] = [
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", 0, "chrome"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", 0, "edge"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0", 0, "firefox"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", 0, "safari"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", 5, "ios"], // an iPad
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131 Mobile/15E148 Safari/604.1", 5, "ios"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", 5, "android"],
    ];
    for (const [ua, touch, kind] of cases) expect(browserKind(ua, touch)).toBe(kind);
  });

  it("has steps for each", () => {
    expect(micHelp("safari")).toContain("Settings for This Website");
    expect(micHelp("firefox")).toContain("Blocked");
    expect(micHelp("other")).toContain("Try again");
  });
});
