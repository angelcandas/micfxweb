import { describe, expect, it } from "vitest";
import { isPartnerOrigin, partnerUrl, validPayload } from "../src/index";

const at = (href: string) => { const u = new URL(href); return { protocol: u.protocol, host: u.host, hostname: u.hostname }; };

describe("hand-off between the apps", () => {
  it("finds the other app on the same domain", () => {
    expect(partnerUrl("daw", at("https://micfxdaw.pages.dev/"))).toBe("https://micfxvoice.pages.dev/");
    expect(partnerUrl("voice", at("https://micfxvoice.sobrinotech.com/"))).toBe("https://micfxdaw.sobrinotech.com/handoff.html");
    expect(partnerUrl("daw", at("http://localhost:4175/"))).toBe("http://localhost:4173/");
    expect(partnerUrl("daw", at("https://x.test/"), "https://voice.test/")).toBe("https://voice.test/");
  });

  it("trusts only the other app", () => {
    const daw = at("https://micfxdaw.sobrinotech.com/");
    expect(isPartnerOrigin("daw", "https://micfxvoice.sobrinotech.com", daw)).toBe(true);
    expect(isPartnerOrigin("daw", "https://evil.com", daw)).toBe(false);
    expect(isPartnerOrigin("daw", "https://micfxvoice.sobrinotech.com.evil.com", daw)).toBe(false);
    expect(isPartnerOrigin("daw", "http://micfxvoice.sobrinotech.com", daw)).toBe(false);
    expect(isPartnerOrigin("daw", "http://localhost:4173", at("http://localhost:4175/"))).toBe(true);
  });

  it("takes only audio files and MIDI mappings", () => {
    const audio = { kind: "audio", name: "Take 1.wav", data: new ArrayBuffer(8) };
    expect(validPayload({ from: "voice", items: [audio] })).toBe(true);
    expect(validPayload({ from: "voice", items: [{ ...audio, name: "run.exe" }] })).toBe(false);
    expect(validPayload({ from: "voice", items: [{ kind: "script", code: "x" }] })).toBe(false);
    expect(validPayload({ from: "someone", items: [audio] })).toBe(false);
    expect(validPayload({ from: "daw", items: [{ kind: "midiMappings", mappings: [] }] })).toBe(true);
  });
});
