import { describe, expect, it } from "vitest";
import { Session, type TakeChunk } from "../src/session";

const RATE = 48000;
const BLOCK = 128;

function constant(frames: number, value: number) {
  return new Float32Array(frames).fill(value);
}

// Runs `blocks` blocks of `voice` through the session; returns the left output.
function run(session: Session, blocks: number, voice = 0, mic = 0) {
  const out: number[] = [];
  for (let b = 0; b < blocks; ++b) {
    const left = constant(BLOCK, voice);
    const right = constant(BLOCK, voice);
    session.process(left, right, constant(BLOCK, mic), BLOCK);
    out.push(...left);
  }
  return out;
}

describe("session", () => {
  it("plays a track at its place, with its gain, under the voice", () => {
    const session = new Session(RATE, () => {});
    session.addTrack(1, [constant(BLOCK * 2, 0.25)], BLOCK);
    session.setTrack(1, { gain: 2 });
    expect(session.length).toBe(BLOCK * 3);

    expect(run(session, 1, 0.1)[0]).toBeCloseTo(0.1); // stopped: only the voice
    session.transport("play");
    const out = run(session, 4, 0.1);
    expect(out[0]).toBeCloseTo(0.1); // before the track starts
    expect(out[BLOCK]).toBeCloseTo(0.6);
    expect(out[BLOCK * 3]).toBeCloseTo(0.1); // after its end
    expect(session.position).toBe(BLOCK * 4);
  });

  it("loops a region round and round, mid-block too", () => {
    const session = new Session(RATE, () => {});
    // A ramp: each frame's value is its place.
    session.addTrack(1, [Float32Array.from({ length: RATE }, (_, i) => i / RATE)], 0);
    session.setLoop(100 / RATE, 300 / RATE);
    session.transport("seek", 250 / RATE);
    session.transport("play");
    const out = run(session, 2);
    expect(out[0]).toBeCloseTo(250 / RATE, 6);
    expect(out[49]).toBeCloseTo(299 / RATE, 6);
    expect(out[50]).toBeCloseTo(100 / RATE, 6); // back to the start
    expect(session.position).toBe(106); // 250..300, 100..300, then 6 more
    session.setLoop();
    expect(session.loop).toBeUndefined();
  });

  it("mutes, removes, seeks and stops", () => {
    const session = new Session(RATE, () => {});
    session.addTrack(7, [constant(RATE, 0.3), constant(RATE, -0.3)], 0);
    session.transport("play");
    session.setTrack(7, { muted: true });
    expect(run(session, 1)[0]).toBe(0);
    session.setTrack(7, { muted: false });
    expect(run(session, 1)[0]).toBeCloseTo(0.3);

    session.transport("seek", 0.5);
    expect(session.position).toBe(RATE / 2);
    session.transport("stop");
    expect(session.position).toBe(0);
    expect(session.playing).toBe(false);

    session.removeTrack(7);
    expect(session.length).toBe(0);
  });

  it("keeps the sum under -1 dB", () => {
    const session = new Session(RATE, () => {});
    session.addTrack(1, [constant(RATE, 0.8)], 0);
    session.transport("play");
    const out = run(session, 50, 0.8);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(0.8914);
  });

  it("records the voice and the dry mic, without the music", () => {
    const chunks: TakeChunk[] = [];
    const session = new Session(RATE, (chunk) => chunks.push(chunk));
    session.addTrack(1, [constant(RATE * 4, 0.2)], 0);
    session.transport("seek", 1);
    session.startRecording(true);
    expect(session.playing).toBe(true);

    const blocks = Math.ceil((RATE * 1.5) / BLOCK);
    run(session, blocks, 0.1, 0.05);
    expect(session.recordingSeconds).toBeCloseTo((blocks * BLOCK) / RATE);
    const end = session.stopRecording();

    expect(end).toEqual({ start: RATE, frames: blocks * BLOCK });
    expect(session.playing).toBe(false);
    expect(session.recordingSeconds).toBe(-1);
    expect(chunks.reduce((sum, c) => sum + c.channels[0].length, 0)).toBe(blocks * BLOCK);
    expect(chunks.every((c) => c.channels[0].every((s) => Math.abs(s - 0.1) < 1e-6))).toBe(true);
    expect(chunks.every((c) => c.dry?.every((s) => Math.abs(s - 0.05) < 1e-6))).toBe(true);
    expect(session.stopRecording()).toBeUndefined();
  });

  it("counts in with clicks, then records from beat 1 and plays; the click is never in the take", () => {
    const chunks: TakeChunk[] = [];
    const session = new Session(RATE, (c) => chunks.push(c));
    session.metronome.set({ bpm: 120, beatsPerBar: 4 }); // a beat is 24000 frames
    session.transport("seek", 1);
    session.startRecording(false, 1); // one bar: 96000 frames
    expect(session.playing).toBe(false);
    expect(session.countInBeats).toBe(4);

    const countIn = run(session, Math.ceil(96000 / BLOCK) - 1, 0, 0.5);
    const beats = [0, 24000, 48000, 72000];
    for (const at of beats) expect(Math.max(...countIn.slice(at, at + 200).map(Math.abs))).toBeGreaterThan(0.05);
    expect(Math.max(...countIn.slice(10000, 20000).map(Math.abs))).toBe(0); // quiet between clicks
    // The downbeat is louder.
    const peak = (at: number) => Math.max(...countIn.slice(at, at + 400).map(Math.abs));
    expect(peak(0)).toBeGreaterThan(peak(24000) * 1.3);
    expect(session.recordingSeconds).toBe(-1);
    expect(session.position).toBe(48000); // the transport waits

    // The block where the count-in ends: the take starts mid-block, at its last frames.
    run(session, 3, 0.25, 0.5);
    expect(session.playing).toBe(true);
    expect(session.countInBeats).toBe(0);
    const frames = Math.ceil(96000 / BLOCK) * BLOCK - 96000 + 2 * BLOCK;
    expect(session.position).toBe(48000 + frames);
    const end = session.stopRecording()!;
    expect(end).toEqual({ start: 48000, frames });
    const take = new Float32Array(chunks.reduce((n, c) => n + c.channels[0].length, 0));
    let at = 0;
    for (const c of chunks) take.set(c.channels[0], (at += c.channels[0].length) - c.channels[0].length);
    expect(take.length).toBe(frames);
    expect(take.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true); // the voice only
  });

  it("clicks on the transport's beats while it plays, and on its own clock when stopped", () => {
    const session = new Session(RATE, () => {});
    session.metronome.set({ on: true, bpm: 120, beatsPerBar: 4 });
    session.transport("seek", 0.25); // mid-beat: the first click waits for beat 2
    session.transport("play");
    const out = run(session, Math.ceil(36000 / BLOCK));
    expect(Math.max(...out.slice(0, 11000).map(Math.abs))).toBe(0);
    expect(Math.max(...out.slice(12000, 12200).map(Math.abs))).toBeGreaterThan(0.05); // 0.5 s
    session.transport("pause");
    const free = run(session, 4);
    expect(Math.max(...free.slice(0, 200).map(Math.abs))).toBeGreaterThan(0.05); // starts on a beat of its own
    session.metronome.set({ on: false });
    expect(Math.max(...run(session, 400).map(Math.abs))).toBe(0);
  });
});
