import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeMp3 } from "../src/mp3";

const module = new WebAssembly.Module(readFileSync(new URL("../dist/mp3.wasm", import.meta.url)));

describe("mp3.wasm (LAME)", () => {
  it("encodes stereo at 192 kbps with an ID3 tag, about the right length", () => {
    const rate = 48000;
    const seconds = 3;
    const left = Float32Array.from({ length: rate * seconds }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const right = Float32Array.from(left, (v) => -v);
    const file = encodeMp3(module, [left, right], rate, 2, { title: "MicFX 2026-11-24 18-00-00", year: "2026", comment: "Recorded with MicFX Voice" });
    expect(new TextDecoder().decode(file.subarray(0, 3))).toBe("ID3");
    const text = new TextDecoder("latin1").decode(file);
    expect(text).toContain("MicFX 2026-11-24 18-00-00");
    // 192 kbps for 3 s is 72 KB, plus the tag and LAME's padding.
    expect(file.length).toBeGreaterThan(65_000);
    expect(file.length).toBeLessThan(85_000);
    // An MPEG frame sync after the tag.
    const start = 10 + ((file[6]! & 0x7f) << 21) + ((file[7]! & 0x7f) << 14) + ((file[8]! & 0x7f) << 7) + (file[9]! & 0x7f);
    expect(file[start]).toBe(0xff);
    expect(file[start + 1]! & 0xe0).toBe(0xe0);
    expect(text).toContain("Info"); // the LAME header of a constant-rate file, filled in
  });

  it("encodes mono, variable rate", () => {
    const voice = Float32Array.from({ length: 44100 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / 44100));
    const file = encodeMp3(module, [voice], 44100, 5);
    expect(file.length).toBeGreaterThan(2000);
    expect(new TextDecoder("latin1").decode(file)).toContain("Xing");
  });
});
