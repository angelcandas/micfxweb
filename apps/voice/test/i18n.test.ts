import { describe, expect, it } from "vitest";
import { pageLanguage, translate } from "../src/i18n";

describe("Spanish", () => {
  it("translates exact keys and keeps the surrounding whitespace", () => {
    expect(translate("Settings")).toBe("Ajustes");
    expect(translate("  Record \n")).toBe("  Grabar \n");
  });
  it("translates the patterns, with effect names inside", () => {
    expect(translate('Robot with the "Dalek" preset')).toBe("Robot con el preset «Dalek»");
    expect(translate("Turn Echo off")).toBe("Desactivar Eco");
    expect(translate("3 on")).toBe("3 activos");
  });
  it("leaves names and unknown text alone", () => {
    expect(translate("My best take")).toBeUndefined();
    expect(translate("")).toBeUndefined();
  });
  it("picks the language from the setting, else the browser", () => {
    expect(pageLanguage("auto", ["es-MX", "en"])).toBe("es");
    expect(pageLanguage("auto", ["en-GB", "es"])).toBe("en");
    expect(pageLanguage("en", ["es-ES"])).toBe("en");
    expect(pageLanguage("es", ["en-US"])).toBe("es");
  });
});
