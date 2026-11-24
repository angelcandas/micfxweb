import { describe, expect, it } from "vitest";
import { dropKind, soundHash } from "../src/drop";
import { uniqueNames } from "../src/handoff";

describe("drag and drop", () => {
  it("knows what a file is by its name, or its type", () => {
    expect(dropKind({ name: "Song.MP3", type: "" })).toBe("audio");
    expect(dropKind({ name: "voice", type: "audio/webm" })).toBe("audio");
    expect(dropKind({ name: "Friday.micfxset", type: "application/xml" })).toBe("setlist");
    expect(dropKind({ name: "MicFX Voice backup.micfxbackup", type: "" })).toBe("backup");
    expect(dropKind({ name: "words.lrc", type: "" })).toBe("lyrics");
    expect(dropKind({ name: "photo.jpg", type: "image/jpeg" })).toBe("unknown");
  });
  it("finds a shared sound in a dropped link", () => {
    expect(soundHash("https://micfxvoice.example/#sound=eyJ2IjoxfQ")).toBe("#sound=eyJ2IjoxfQ");
    expect(soundHash("https://example.com/page")).toBeUndefined();
  });
});

describe("hand-off", () => {
  it("keeps the names apart", () => {
    expect(uniqueNames([{ name: "Take 1.wav" }, { name: "take 1.wav" }, { name: "Song.wav" }]).map((t) => t.name)).toEqual(["Take 1.wav", "take 1 (2).wav", "Song.wav"]);
  });
});
