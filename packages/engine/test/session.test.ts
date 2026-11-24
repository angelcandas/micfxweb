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
});
