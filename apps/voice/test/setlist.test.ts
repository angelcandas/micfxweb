import { describe, expect, it } from "vitest";
import type { ParameterInfo } from "@micfx/bridge";
import type { LooperState } from "@micfx/engine";
import type { ParameterAccess, SavedScenes } from "../src/live-state";
import { Setlist, toXml, type SavedSetlist } from "../src/setlist";

const info: Record<string, ParameterInfo> = {
  inputGain: { name: "Input Gain", min: -24, max: 24, skew: 1, step: 0.1, label: "dB", default: 0 },
  reverbMix: { name: "Reverb Mix", min: 0, max: 100, skew: 1, step: 0, label: "%", default: 20 },
  tuneKey: { name: "Autotune Key", min: 0, max: 11, skew: 1, step: 1, label: "", default: 0, choices: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] },
  tuneScale: { name: "Autotune Scale", min: 0, max: 2, skew: 1, step: 1, label: "", default: 0, choices: ["Chromatic", "Major", "Minor"] },
};

function makeHost() {
  const values: Record<string, number> = Object.fromEntries(Object.entries(info).map(([id, p]) => [id, p.default]));
  const params: ParameterAccess = { ids: Object.keys(info), info, get: (id) => values[id]!, set: (id, v) => (values[id] = v) };
  const files = new Map<string, Blob>();
  let scenes: SavedScenes = { scenes: [], active: -1, glide: 0.5 };
  const looper = { state: "empty", bpm: 120, locked: false } as LooperState;
  const host = {
    values,
    files,
    looper,
    order: "",
    backing: undefined as { name: string; file: Blob } | undefined,
    loaded: [] as (string | undefined)[],
    stops: 0,
    saved: undefined as SavedSetlist | undefined,
  };
  const setlist = new Setlist({
    params,
    getOrder: () => host.order,
    setOrder: (order) => (host.order = order),
    scenes: { save: () => scenes, restore: (s) => (scenes = s ?? scenes) },
    looper: () => looper,
    looperStop: () => host.stops++,
    looperTempo: (bpm) => Object.assign(looper, { bpm, locked: true }),
    currentBacking: () => host.backing,
    replaceBacking: async (file) => {
      host.loaded.push(file?.name);
      host.backing = file && { name: file.name, file };
    },
    files: {
      put: async (id, file) => void files.set(id, file),
      get: async (id) => files.get(id),
      prune: async (keep) => [...files.keys()].forEach((id) => keep.has(id) || files.delete(id)),
    },
    persist: (saved) => (host.saved = saved),
  });
  return { setlist, host, getScenes: () => scenes };
}

describe("setlist", () => {
  it("adds songs from the sound there is now and loads them back", async () => {
    const { setlist, host } = makeHost();
    host.values.reverbMix = 55;
    host.values.inputGain = 6;
    host.values.tuneScale = 1; // a major scale: it follows the song's mode
    host.order = "reverb,eq";
    host.looper.locked = true;
    host.looper.bpm = 96;
    host.backing = { name: "Ballad.mp3", file: new File(["abc"], "Ballad.mp3") };
    expect(await setlist.add()).toBe(0);
    expect(setlist.describe().songs[0]).toMatchObject({ name: "Ballad", tempo: 96, backing: "Ballad.mp3" });
    expect(host.files.size).toBe(1);

    host.values.reverbMix = 10;
    host.order = "";
    host.looper.locked = false;
    host.backing = undefined;
    await setlist.add("Rock");
    expect(setlist.getCurrent()).toBe(1);

    setlist.setInfo(0, { key: 9, minor: true });
    host.values.inputGain = -3;
    const result = await setlist.load(0);
    expect(result).toEqual({ ok: true, warning: "" });
    expect(host.values.reverbMix).toBe(55);
    expect(host.values.inputGain).toBe(-3); // the mic's level stays
    expect(host.values.tuneKey).toBe(9);
    expect(host.values.tuneScale).toBe(2);
    expect(host.order).toBe("reverb,eq");
    expect(host.looper).toMatchObject({ bpm: 96, locked: true });
    expect(host.loaded).toEqual(["Ballad.mp3"]);
    expect(host.saved?.current).toBe(0);

    await setlist.step(1);
    expect(host.values.reverbMix).toBe(10);
    expect(host.loaded).toEqual(["Ballad.mp3", undefined]);
    expect((await setlist.step(1)).ok).toBe(false); // no wrap
  });

  it("stops a playing loop on a song change, and warns about a missing backing track", async () => {
    const { setlist, host } = makeHost();
    await setlist.add("One");
    setlist.setInfo(0, { backing: "Elsewhere.wav" });
    host.looper.state = "playing";
    const result = await setlist.load(0);
    expect(host.stops).toBe(1);
    expect(result.warning).toContain("Elsewhere.wav");
  });

  it("moves and removes songs, keeping the loaded one", async () => {
    const { setlist } = makeHost();
    for (const name of ["A", "B", "C"]) await setlist.add(name);
    await setlist.load(0);
    setlist.move(0, 2);
    expect(setlist.describe().songs.map((s) => s.name)).toEqual(["B", "C", "A"]);
    expect(setlist.getCurrent()).toBe(2);
    setlist.remove(0);
    expect(setlist.getCurrent()).toBe(1);
    setlist.remove(1);
    expect(setlist.getCurrent()).toBe(-1);
  });

  it("drops song files no song uses", async () => {
    const { setlist, host } = makeHost();
    await setlist.add("A");
    await setlist.setBacking(0, new File(["one"], "one.wav"));
    await setlist.setBacking(0, new File(["two!"], "two.wav"));
    await new Promise((r) => setTimeout(r));
    expect([...host.files.keys()]).toEqual(["two.wav|4"]);
  });

  it("writes the desktop's .micfxset XML", async () => {
    const { setlist, host } = makeHost();
    await setlist.add("Say \"hi\" & go");
    setlist.setInfo(0, { lyrics: "line one\nline <two>", key: 2 });
    expect(setlist.dirty).toBe(true);
    const xml = setlist.toFile();
    expect(setlist.dirty).toBe(false);
    expect(xml).toContain('<SONG name="Say &quot;hi&quot; &amp; go" sound="reverbMix=20;tuneKey=0;tuneScale=0"');
    expect(xml).toContain('lyrics="line one&#10;line &lt;two&gt;"');
    expect(xml).toContain('key="2" minor="0"');
    expect(xml).not.toContain("inputGain");
    expect(toXml([])).toContain("<SETLIST>");
    expect(host.saved?.dirty).toBe(false);
  });
});
