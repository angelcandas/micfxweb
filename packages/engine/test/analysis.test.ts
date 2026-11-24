import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Analysis, MIX_STYLES } from "../src/analysis";
import { instantiateEngineModule } from "../src/engine";

const RATE = 48000;
let analysis: Analysis;

beforeAll(() => {
  const bytes = readFileSync(fileURLToPath(new URL("../dist/analysis.wasm", import.meta.url)));
  analysis = new Analysis(new WebAssembly.Module(bytes));
});

// Phrases of a sung "ah" (about 2 s each) with pauses between them, over a little room noise
// and some low rumble: what a sound check hears.
function singing(seconds: number, level = 0.25, room = 0.004): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  let seed = 7;
  const notes = [220, 247, 262, 196, 233];
  for (let i = 0; i < out.length; ++i) {
    const t = i / RATE;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = room * (seed / 2 ** 32 - 0.5) + 0.002 * Math.sin(2 * Math.PI * 50 * t);
    const phrase = Math.floor(t / 3.2);
    const inPhrase = t % 3.2;
    let voice = 0;
    if (inPhrase < 2.0) {
      const f = notes[phrase % notes.length]! * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, inPhrase / 0.05, (2.0 - inPhrase) / 0.1);
      for (let h = 1; h <= 12; ++h) voice += Math.sin(phase * h) / (h * (h > 3 ? 1.5 : 1));
      voice *= level * env;
    }
    out[i] = voice + noise;
  }
  return out;
}

describe("analysis.wasm", () => {
  it("names the Auto Mix styles", () => {
    expect(analysis.styles()).toEqual(MIX_STYLES);
  });

  it("plans a Live chain for a voice, with the room's profile", () => {
    const started = performance.now();
    const plan = analysis.soundCheck(singing(15, 0.25, 0.02), RATE, { style: 0 });
    const took = performance.now() - started;
    expect(plan.error).toBe("");
    const ids = plan.values.map(([id]) => id);
    expect(ids).toContain("hpfOn");
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.peak).toBeLessThan(0);
    expect(plan.sung).toBeGreaterThan(8);
    expect(took).toBeLessThan(5000);

    // A noisy room: the denoiser comes on, and the Live engine's takes the room's profile.
    expect(plan.values).toContainEqual(["denoiseOn", 1]);
    expect(plan.noiseProfile.length).toBeGreaterThan(0);
    {
      const engine = instantiateEngineModule(
        new WebAssembly.Module(readFileSync(fileURLToPath(new URL("../dist/engine.wasm", import.meta.url)))),
      ).create(RATE);
      expect(engine.offerNoiseProfile(plan.noiseProfile)).toBe(true);
    }
  });

  it("fits only the levels of the chain there is", () => {
    const plan = analysis.soundCheck(singing(12, 0.05), RATE, {
      fit: { inputGainDb: 0, minInputDb: -24, maxInputDb: 24, gate: true, classicDeEsser: false, denoise: false, lowCutHz: 80 },
    });
    expect(plan.error).toBe("");
    const values = Object.fromEntries(plan.values);
    expect(values.inputGain).toBeGreaterThan(3); // a quiet voice is brought up
    expect(plan.changes.length).toBeGreaterThan(0);
  });

  it("refuses too little voice", () => {
    const plan = analysis.soundCheck(new Float32Array(RATE * 8), RATE, { style: 0 });
    expect(plan.error).not.toBe("");
    expect(plan.values).toEqual([]);
  });

  it("finds the melody of a voice and scores singing against it, as Practice does", () => {
    const { melody, key } = analysis.findMelody(singing(16), RATE);
    expect(melody).not.toBe("");
    expect(typeof key).toBe("string");
    const song = analysis.scoreSong(melody);
    const notes = song.notes.length / 4;
    expect(notes).toBeGreaterThan(3);
    expect(song.phrases.length / 2).toBeGreaterThan(1);
    expect(song.lowest).toBeGreaterThan(50);
    expect(song.highest).toBeLessThan(65);

    // Sing every note in tune, 5 ms at a time, and play the song to its end.
    const frames: number[] = [];
    for (let i = 0; i < notes; ++i) {
      const [start, end, pitch] = song.notes.slice(i * 4, i * 4 + 3) as [number, number, number];
      for (let t = start; t < end; t += 0.005) frames.push(t, pitch);
    }
    const end = song.notes[song.notes.length - 3]! + 1;
    analysis.scoreFrames(new Float64Array(frames), end);
    const changes = analysis.scoreChanges();
    expect(changes?.reset).toBe(true);
    expect(changes?.notes.length).toBe(notes);
    expect(changes?.pass).toBeGreaterThan(80);
    expect(analysis.scoreChanges()).toBeUndefined(); // nothing new since

    const report = analysis.scoreReport();
    expect(report.scored).toBe(song.phrases.length / 2);
    expect(report.score).toBeGreaterThan(80);

    // A jump back: what follows is sung again.
    analysis.scoreRestart(0);
    expect(analysis.scoreChanges(true)?.notes.length).toBe(0);

    // Lyrics: plain lines go on the phrases; an .lrc keeps its times; a nudge pins a line.
    const placed = analysis.lyricsSet("La la la la\nOh oh oh oh\nHey hey hey");
    expect(placed.lines.map((l) => l.text)).toEqual(["La la la la", "Oh oh oh oh", "Hey hey hey"]);
    expect(placed.lines.every((l) => l.timed && l.end > l.start)).toBe(true);
    expect(placed.lines[1]!.start).toBeGreaterThan(placed.lines[0]!.start);
    expect(placed.lines[0]!.words).toHaveLength(8); // [text, start] per word
    expect(placed.lrc).toMatch(/^\[\d\d:\d\d\.\d\d\]La la la la/);
    const moved = analysis.lyricsNudge(1, 0.25);
    expect(moved.lines[1]!.pinned).toBe(true);
    expect(moved.lines[1]!.start).toBeCloseTo(placed.lines[1]!.start + 0.25, 2);
    const kept = analysis.lyricsSet(moved.saved, true);
    expect(kept.lines[1]!.start).toBeCloseTo(moved.lines[1]!.start, 2);
    expect(analysis.lyricsAlign(true).lines[1]!.pinned).toBe(false);
    const lrc = analysis.lyricsSet("[00:01.50]First\n[00:04.00]Second");
    expect(lrc.lines.map((l) => [l.text, l.start])).toEqual([["First", 1.5], ["Second", 4]]);
  });

  it("maps a song's sections, as Practice's loop strip shows them", { timeout: 60_000 }, () => {
    // 120 BPM, 8 bars of a quiet part (A minor) then 8 of a loud one (F major), twice.
    const rate = 22050;
    const bar = 2;
    const song = new Float32Array(64 * bar * rate);
    const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6]];
    for (let i = 0; i < song.length; ++i) {
      const t = i / rate;
      const part = Math.floor(t / (8 * bar)) % 2;
      const beat = t % 0.5;
      let x = 0.4 * Math.sin(2 * Math.PI * 60 * beat) * Math.exp(-beat * 18); // kick on every beat
      if (Math.floor(t / 0.25) % 2 === 1) x += 0.08 * Math.sin(2 * Math.PI * 4000 * t) * Math.exp(-(t % 0.25) * 60); // hat
      for (const f of chords[part]!) x += (part ? 0.12 : 0.05) * Math.sin(2 * Math.PI * f * t);
      song[i] = x;
    }
    const sections = analysis.sections(song, rate);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < sections.length; ++i) expect(sections[i]!.start).toBeCloseTo(sections[i - 1]!.end, 2);
    expect(new Set(sections.map((s) => s.letter)).size).toBeLessThan(sections.length); // parts come back
    expect(sections[0]).toMatchObject({ name: expect.any(String), colour: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
  });

  it("changes a song's key and speed, and scores the melody moved with it", () => {
    const rate = 22050;
    const tone = Float32Array.from({ length: 2 * rate }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));
    const [slower] = analysis.warp([tone], rate, 0.8, 0, false);
    expect(slower!.length).toBeCloseTo(2.5 * rate, -3);
    const [higher] = analysis.warp([tone], rate, 1, 12, false);
    expect(higher!.length).toBeCloseTo(2 * rate, -3);
    // An octave up: about twice as many zero crossings in the middle.
    const crossings = (x: Float32Array) => {
      let n = 0;
      for (let i = rate / 2; i < rate * 1.5; ++i) if (x[i - 1]! < 0 !== x[i]! < 0) ++n;
      return n;
    };
    expect(crossings(higher!) / crossings(tone)).toBeCloseTo(2, 1);

    const { melody } = analysis.findMelody(singing(16), RATE);
    const song = analysis.scoreSong(melody);
    const moved = analysis.scoreShift(2, 0.5, 0);
    expect(moved.notes[0]).toBeCloseTo(song.notes[0]! * 2, 2);
    expect(moved.notes[2]).toBeCloseTo(song.notes[2]! + 2, 2);
    expect(analysis.scoreShift(0, 1, 0).notes).toEqual(song.notes);
  });
});
