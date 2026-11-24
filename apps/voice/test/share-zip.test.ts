import { describe, expect, it } from "vitest";
import { readSoundHash, soundHash } from "../src/share";
import { crc32, readZip, writeZip } from "../src/zip";

describe("a sound as a link", () => {
  const defaults = { inputGain: 0, reverbOn: 0, reverbMix: 0.3, tuneOn: 0 };
  it("carries only what changed, and the order when it moved", () => {
    const hash = soundHash({ inputGain: 6, reverbOn: 1, reverbMix: 0.123456, tuneOn: 0 }, defaults, ["reverb", "tune"], ["tune", "reverb"], "Big room");
    expect(hash).toMatch(/^sound=[A-Za-z0-9_-]+$/);
    const sound = readSoundHash(`#${hash}`, (id) => id in defaults)!;
    expect(sound.values).toEqual({ reverbOn: 1, reverbMix: 0.1235 }); // not the mic's level
    expect(sound.order).toEqual(["reverb", "tune"]);
    expect(sound.name).toBe("Big room");
  });
  it("leaves the order out when it's the default, and ignores what it doesn't know", () => {
    const hash = soundHash({ reverbOn: 1, gone: 3 }, defaults, ["tune", "reverb"], ["tune", "reverb"]);
    const sound = readSoundHash(hash, (id) => id in defaults)!;
    expect(sound.order).toBeUndefined();
    expect(sound.values).toEqual({ reverbOn: 1 });
    expect(readSoundHash("#sound=%%%", () => true)).toBeUndefined();
    expect(readSoundHash("#other=1", () => true)).toBeUndefined();
  });
});

describe("zip", () => {
  it("has the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("round-trips files, names in UTF-8 included", async () => {
    const audio = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff);
    const zip = await writeZip([
      { name: "micfx-backup.json", data: new Blob(['{"a":1}']) },
      { name: "tracks/1/Canción.wav", data: new Blob([audio]) },
      { name: "empty", data: new Blob([]) },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["micfx-backup.json", "tracks/1/Canción.wav", "empty"]);
    expect(await entries[0]!.data.text()).toBe('{"a":1}');
    expect(new Uint8Array(await entries[1]!.data.arrayBuffer())).toEqual(audio);
    expect(entries[2]!.data.size).toBe(0);
    await expect(readZip(new Blob(["not a zip"]))).rejects.toThrow(/isn't a MicFX backup/);
  });
});
