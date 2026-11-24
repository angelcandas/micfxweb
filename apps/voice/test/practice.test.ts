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
  const host: PracticeHost = {
    store,
    scorer: async () => scorer,
    decode: async () => new Float32Array(44100 * 3),
    findMelody: async () => ({ melody, key: "A minor" }),
    pickFile: async () => picked,
    install: async () => {
      tracks.length = 0;
      tracks.push(7);
      return 7;
    },
    setGuide: (id, level) => void guides.push([id, level]),
    trackIds: () => tracks,
    restart: () => {},
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
  return { practice, host, store, events, calls, guides, waitFor, pick: (file: File) => (picked = file), saved: () => saved, pitchOn: () => pitchOn };
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
    expect(await t.practice.handle("library")).toEqual([{ id, name: "My Song", key: "A minor", seconds: 3, voiceOnly: true, opened: 1000, current: true }]);

    // The same file again: from the library, no analysis.
    t.events.length = 0;
    await t.practice.handle("open", { split: false });
    expect((await t.waitFor("ready")).fromCache).toBe(true);
    expect(t.events.some(([, e]) => e?.job?.phase === "listening")).toBe(false);

    await t.practice.handle("openCached", { id });
    await t.practice.handle("forget", { id }); // the current song stays
    expect(t.store.files.size).toBe(3);
  });

  it("says when there is no melody, and that splitting a song is still to come", async () => {
    const t = setup("");
    t.pick(new File(["x"], "Hum.wav"));
    await t.practice.handle("open", { split: false });
    expect((await t.waitFor("error")).error).toContain("Couldn't find a sung melody");

    const split = setup();
    const answer = (await split.practice.handle("open", { split: true })) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect((await split.waitFor("error")).error).toContain("voice on its own");
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
});
