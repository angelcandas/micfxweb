import { describe, expect, it } from "vitest";
import { Practice, fileId, type PracticeHost, type PracticeScorer, type PracticeStore } from "../src/practice";

function memoryStore(): PracticeStore & { files: Map<string, Blob> } {
  const files = new Map<string, Blob>();
  return {
    files,
    folders: async () => [...new Set([...files.keys()].map((k) => k.split("/")[0]!))],
    read: async (folder, name) => files.get(`${folder}/${name}`),
    write: async (folder, name, data) => void files.set(`${folder}/${name}`, typeof data === "string" ? new Blob([data]) : data),
    remove: async (folder) => {
      for (const key of [...files.keys()]) if (key.startsWith(`${folder}/`)) files.delete(key);
    },
  };
}

function fakeScorer() {
  const calls: string[] = [];
  let pending = false;
  const scorer: PracticeScorer = {
    scoreSong: () => ((pending = true), { notes: [0, 1, 60, 0, 1, 2, 62, 0], phrases: [0, 2], lowest: 60, highest: 62 }),
    scoreFrames: (frames, time) => {
      calls.push(`frames ${frames.length / 2} @${time}`);
      if (time > 2) pending = true;
    },
    scoreRestart: (time) => void calls.push(`restart @${time}`),
    scoreTime: () => {},
    scoreChanges: (all) => (all || pending ? ((pending = false), { reset: false, from: 0, notes: [], phrases: [{ i: 0, scored: true, score: 80 }], pass: 80 }) : undefined),
    scoreReport: () => ({ score: 80 }),
    scoreShift: (semitones, speed, time) => {
      calls.push(`shift ${semitones} ${speed} @${time}`);
      return { notes: [0, 1 / speed, 60 + semitones, 0, 1 / speed, 2 / speed, 62 + semitones, 0], phrases: [0, 2 / speed], lowest: 60 + semitones, highest: 62 + semitones };
    },
    // Lines a second apart; what's kept is the text.
    lyricsSet: (text) => lyricsOf(text),
    lyricsAlign: () => lyricsOf(lastLyrics),
    lyricsNudge: (index, by) => {
      const lyrics = lyricsOf(lastLyrics);
      lyrics.lines[index]!.start += by;
      lyrics.lines[index]!.pinned = true;
      return lyrics;
    },
  };
  let lastLyrics = "";
  const lyricsOf = (text: string) => {
    lastLyrics = text;
    const lines = text.split("\n").filter(Boolean).map((line, i) => ({ text: line, start: i, end: i + 1, pinned: false, timed: true, words: [line, i] }));
    return { lines, saved: text, lrc: lines.map((l) => `[00:0${l.start}.00]${l.text}`).join("\n") };
  };
  return { scorer, calls };
}

function setup(melody = "notes") {
  const store = memoryStore();
  const { scorer, calls } = fakeScorer();
  const events: [string, any][] = [];
  const tracks: number[] = [];
  const guides: [number, number][] = [];
  let saved: string | null = null;
  let picked: File | undefined;
  let pitchOn = false;
  const downloads: [string, Blob][] = [];
  const transport: string[] = [];
  const warps: number[] = [];
  const host: PracticeHost = {
    store,
    scorer: async () => scorer,
    decode: async () => [new Float32Array(44100 * 20), new Float32Array(44100 * 20)],
    split: async (song, report) => {
      report("downloading", 0.5);
      report("splitting", 1);
      return { voice: song, backing: song };
    },
    encodeWav: (channels) => new Blob([`wav ${channels.length}`]),
    findMelody: async () => ({ melody, key: "A minor" }),
    pickFile: async () => picked,
    download: (blob, name) => void downloads.push([name, blob]),
    install: async () => {
      tracks.length = 0;
      tracks.push(7);
      return 7;
    },
    setGuide: (id, level) => void guides.push([id, level]),
    trackIds: () => tracks,
    restart: () => {},
    seek: (seconds, play) => void transport.push(`seek ${seconds}${play ? " play" : ""}`),
    loop: (from, to) => void transport.push(from === undefined ? "unloop" : `loop ${from}-${to}`),
    sections: async () => [
      { name: "Verse 1", kind: "verse", letter: "A", colour: "#4f8cff", start: 0, end: 8, bars: 4 },
      { name: "Chorus 1", kind: "chorus", letter: "B", colour: "#ff7a59", start: 8, end: 16, bars: 4 },
    ],
    warp: async (channels, _rate, speed) => {
      warps.push(speed);
      return channels.map((c) => new Float32Array(Math.round(c.length / speed)));
    },
    pitch: (on) => void (pitchOn = on),
    latency: () => 0,
    emit: (name, payload) => void events.push([name, payload]),
    load: () => saved,
    save: (value) => void (saved = value),
    now: () => 1000,
  };
  const practice = new Practice(host);
  const waitFor = async (state: string) => {
    for (let i = 0; i < 50 && !events.some(([n, e]) => n === "practice" && e.state === state); ++i) await new Promise((r) => setTimeout(r));
    return events.find(([n, e]) => n === "practice" && e.state === state)?.[1];
  };
  return { practice, host, store, events, calls, guides, waitFor, pick: (file: File) => (picked = file), saved: () => saved, pitchOn: () => pitchOn, downloads, transport, warps };
}

describe("practice", () => {
  it("prepares a voice-only song, keeps it in the library, and opens it again from there", async () => {
    const t = setup();
    const voice = new File(["voice audio"], "My Song.wav");
    t.pick(voice);
    await t.practice.handle("open", { split: false });
    const ready = await t.waitFor("ready");
    expect(ready.fromCache).toBe(false);
    expect(ready.song).toMatchObject({ name: "My Song", key: "A minor", notes: [0, 1, 60, 0, 1, 2, 62, 0], hasBacking: false, loop: null });
    expect(t.events.some(([n, e]) => n === "practice" && e.state === "preparing" && e.job.phase === "listening")).toBe(true);

    const id = `${await fileId(voice)}-voice`;
    expect(id).toMatch(/^[0-9a-f]{20}-voice$/);
    expect([...t.store.files.keys()].sort()).toEqual([`${id}/My Song.wav`, `${id}/info.json`, `${id}/melody.txt`]);
    expect(await t.practice.handle("library")).toEqual([{ id, name: "My Song", key: "A minor", seconds: 20, voiceOnly: true, opened: 1000, current: true, best: 0, last: 0, passes: 0 }]);

    // The same file again: from the library, no analysis.
    t.events.length = 0;
    await t.practice.handle("open", { split: false });
    expect((await t.waitFor("ready")).fromCache).toBe(true);
    expect(t.events.some(([, e]) => e?.job?.phase === "listening")).toBe(false);

    await t.practice.handle("openCached", { id });
    await t.practice.handle("forget", { id }); // the current song stays
    expect(t.store.files.size).toBe(3);
  });

  it("says when there is no melody", async () => {
    const t = setup("");
    t.pick(new File(["x"], "Hum.wav"));
    await t.practice.handle("open", { split: false });
    expect((await t.waitFor("error")).error).toContain("Couldn't find a sung melody");
  });

  it("splits a song into its voice (the guide) and backing, and keeps both", async () => {
    const t = setup();
    const song = new File(["a whole song"], "Full Song.mp3");
    t.pick(song);
    await t.practice.handle("open", { split: true });
    const ready = await t.waitFor("ready");
    expect(ready.song).toMatchObject({ name: "Full Song", hasBacking: true });
    const phases = t.events.filter(([, e]) => e?.state === "preparing").map(([, e]) => e.job.phase);
    expect(phases).toEqual(expect.arrayContaining(["reading", "downloading", "listening"]));
    const id = await fileId(song);
    expect([...t.store.files.keys()].sort()).toEqual([`${id}/backing.wav`, `${id}/guide.wav`, `${id}/info.json`, `${id}/melody.txt`]);
    expect((await t.practice.handle("library")) as unknown[]).toMatchObject([{ id, voiceOnly: false }]);
  });

  it("scores the pitch readings as the song plays, restarts on a jump, and reports when it stops", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    await t.practice.handle("view", { open: true });
    expect(t.pitchOn()).toBe(true);

    const rate = 1000;
    const readings = (from: number) => Float64Array.from([from * rate, 60, -20, (from + 0.005) * rate, 60.2, -20]);
    t.practice.tick(readings(0.5), { position: 0.5, playing: true }, rate);
    const pitch = t.events.filter(([n]) => n === "practicePitch").at(-1)![1];
    expect(pitch).toMatchObject({ time: 0.5, playing: true, midi: 60.2, frames: [0.5, 60, 0.505, 60.2] });

    t.practice.tick(readings(2.5), { position: 2.5, playing: true }, rate); // > 0.75 s on: a seek
    expect(t.calls).toContain("restart @2.5");
    expect(t.events.some(([n]) => n === "practiceScore")).toBe(true);

    t.practice.tick(undefined, { position: 2.6, playing: false }, rate);
    expect(t.events.find(([n]) => n === "practiceReport")?.[1]).toEqual({ score: 80 });
  });

  it("places lyrics, keeps them with the song, and saves them as an .lrc", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    const lines = (await t.practice.handle("lyrics", { text: "One\nTwo" })) as { text: string; start: number }[];
    expect(lines.map((l) => l.text)).toEqual(["One", "Two"]);
    const nudged = (await t.practice.handle("nudgeLyric", { line: 1, at: 1.5 })) as { start: number; pinned: boolean }[];
    expect(nudged[1]).toMatchObject({ start: 1.5, pinned: true });

    await t.practice.handle("exportLyrics");
    expect(t.downloads[0]?.[0]).toBe("Song.lrc");
    expect(await t.downloads[0]![1].text()).toContain("[00:00.00]One");

    // Opened again from the library: the lyrics come with it.
    const [entry] = (await t.practice.handle("library")) as { id: string }[];
    t.events.length = 0;
    await t.practice.handle("openCached", { id: entry!.id });
    expect((await t.waitFor("ready")).song.lyrics.map((l: { text: string }) => l.text)).toEqual(["One", "Two"]);
  });

  it("changes the key and speed (rendered once, then kept), and loops a phrase or a section", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    await t.practice.handle("lyrics", { text: "One\nTwo" });

    t.events.length = 0;
    await t.practice.handle("speed", { speed: 0.5, semitones: -2 });
    expect(t.warps).toEqual([0.5]); // the guide (no backing on a voice-only song)
    expect(t.events.some(([, e]) => e?.state === "shifting" && e.shift.pending && e.shift.target.speed === 0.5)).toBe(true);
    const ready = t.events.find(([, e]) => e?.state === "ready")![1];
    expect(ready.song.shift).toMatchObject({ speed: 0.5, semitones: -2, pending: false });
    expect(ready.song.notes[2]).toBe(58); // the melody moved with it
    expect(ready.song.lyrics[1].start).toBe(2); // and the lyrics are in the time it plays
    expect([...t.store.files.keys()].some((k) => k.endsWith("shift-0.500--2.00-guide.wav"))).toBe(true);

    // Back and forth: the original needs nothing rendered; the same change again is kept.
    await t.practice.handle("speed", { speed: 1, semitones: 0 });
    await t.practice.handle("speed", { speed: 0.5, semitones: -2 });
    expect(t.warps).toEqual([0.5]);

    // A phrase loop starts a moment before it, in the song as it plays (half speed: twice as late).
    t.events.length = 0;
    await t.practice.handle("loop", { phrase: 0 });
    expect(t.transport.at(-2)).toBe("loop 0-5.2"); // (0 - 1.5 lead-in → 0) .. (2 + 0.6) / 0.5
    expect(t.transport.at(-1)).toBe("seek 0 play");
    expect(t.events[0]?.[1]).toMatchObject({ state: "loop", song: { loop: { phrase: 0, lastPhrase: 0, section: -1 } } });

    // Sections: found once, kept, then a section loop.
    await t.practice.handle("sections");
    const found = await t.waitFor("sections");
    for (let i = 0; i < 20 && !Array.isArray(t.events.filter(([, e]) => e?.state === "sections").at(-1)?.[1].sections); ++i) await new Promise((r) => setTimeout(r));
    expect(t.events.filter(([, e]) => e?.state === "sections").at(-1)?.[1].sections).toHaveLength(2);
    expect(found).toBeDefined();
    await t.practice.handle("loop", { section: 1, speed: 0.5, semitones: -2 });
    expect(t.transport.at(-2)).toBe("loop 13-33.2"); // (8 - 1.5) / 0.5 .. (16 + 0.6) / 0.5
    expect((await t.practice.handle("state")) as { song: { loop: { phrase: number; lastPhrase: number } } }).toMatchObject({ song: { loop: { phrase: -1, section: 1 } } });

    await t.practice.handle("unloop");
    expect(t.transport.at(-1)).toBe("unloop");
  });

  it("keeps the guide level and picks the song up again after a reload", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    await t.practice.handle("guide", { level: 0.8 });
    expect(t.guides).toEqual([[7, 0.8]]);

    const again = new Practice({ ...t.host, emit: (n, e) => void t.events.push([n, e]) });
    expect((await again.handle("state")) as { guideLevel: number }).toMatchObject({ guideLevel: 0.8, song: null });
    t.events.length = 0;
    await again.restore();
    expect(t.events[0]?.[1]).toMatchObject({ state: "ready", quiet: true, song: { name: "Song" } });
  });

  it("keeps labels on notes (snapped, in the song as recorded) and a reusable library", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    const first = (await t.practice.handle("labels")) as any;
    expect(first.library.length).toBeGreaterThan(8);
    expect(first.annotations).toEqual([]);

    const grit = first.library[0];
    t.events.length = 0;
    await t.practice.handle("annotate", { kind: "note", time: 1.02, labels: [grit] });
    expect(t.events.at(-1)![1]).toMatchObject({ state: "annotations", annotations: [{ kind: "note", time: 1, labels: [{ text: "Grit" }] }] });
    await t.practice.handle("annotate", { kind: "note", time: 1.5, labels: [grit] }); // between notes: nothing
    expect(((await t.practice.handle("labels")) as any).annotations).toHaveLength(1);

    // It's kept: the song opened again has it.
    const reload = new Practice(t.host);
    await reload.restore();
    expect(((await reload.handle("labels")) as any).annotations.length).toBe(1);

    const saved = (await t.practice.handle("saveLabels", { library: [{ text: "Twang", icon: "~", colour: "nope" }] })) as any[];
    expect(saved).toMatchObject([{ text: "Twang", icon: "~", colour: "#8c7bff" }]);
    expect(saved[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(((await new Practice(t.host).handle("labels")) as any).library).toMatchObject([{ text: "Twang" }]);
    expect(((await t.practice.handle("saveLabels", { reset: true })) as any[]).length).toBeGreaterThan(8);
  });

  it("edits the notes, keeps the edit beside the found ones, and can put them back", async () => {
    const t = setup("found");
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    const folder = [...t.store.files.keys()][0]!.split("/")[0]!;

    expect(await t.practice.handle("setMelody", { notes: [] })).toMatchObject({ ok: false });
    const edited = (await t.practice.handle("setMelody", { notes: [1, 2, 64, 0, 0.5, 70] })) as any;
    expect(edited.song.edited).toBe(true);
    expect(await (await t.store.read(folder, "melody-edited.txt"))!.text()).toBe("0.000 0.500 70.00\n1.000 2.000 64.00\n");
    expect(await (await t.store.read(folder, "melody.txt"))!.text()).toBe("found");
    expect(((await t.practice.handle("library")) as any[])[0].id).toBe(folder);

    const reload = new Practice(t.host);
    await reload.restore();
    expect(t.events.at(-1)![1]).toMatchObject({ state: "ready", song: { edited: true } });

    const back = (await t.practice.handle("resetMelody")) as any;
    expect(back.song.edited).toBe(false);
  });

  it("keeps each whole pass for the take review: its pitch and what it scored", async () => {
    const t = setup();
    t.pick(new File(["voice"], "Song.wav"));
    await t.practice.handle("open", { split: false });
    await t.waitFor("ready");
    expect(await t.practice.handle("takes")).toEqual([]);
    t.events.length = 0;
    await t.practice.handle("review", { id: 1 });
    expect(t.events[0]![1]).toMatchObject({ state: "review", review: null });

    // Sing a few seconds, then stop: a pass.
    await t.practice.handle("view", { open: true });
    (await t.host.scorer()).scoreReport = () => ({ score: 80, lean: -4, scored: 1, total: 1 });
    const pitch = (seconds: number[], midi: number) => Float64Array.from(seconds.flatMap((s) => [s * 44100, midi, -20]));
    t.practice.tick(pitch([0.5, 0.6, 0.7, 0.8], 60), { position: 0.9, playing: true }, 44100);
    t.practice.tick(undefined, { position: 0.9, playing: false }, 44100);
    const takes = (await t.practice.handle("takes")) as any[];
    expect(takes).toMatchObject([{ id: 1, name: "Recording 1", speed: 1, semitones: 0, muted: false }]);

    t.events.length = 0;
    await t.practice.handle("review", { id: 1 });
    expect(t.events[0]![1].review).toMatchObject({ take: 1, name: "Recording 1", notes: [0, 1, 60, 0, 1, 2, 62, 0], score: 80 });
    expect(t.events[0]![1].review.frames.length).toBeGreaterThanOrEqual(4);

    // Kept: the same song opened again has it.
    const reload = new Practice(t.host);
    await reload.restore();
    expect(((await reload.handle("takes")) as any[]).length).toBe(1);
  });
});
