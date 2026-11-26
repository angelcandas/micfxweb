// A hummed melody as notes, and as a MIDI file.
export interface Note { start: number; end: number; pitch: number }

/** The analysis' melody text: "start end midiPitch" on each line. */
export function parseMelody(text: string): Note[] {
  const notes: Note[] = [];
  for (const line of text.split("\n")) {
    const [start, end, pitch] = line.trim().split(/\s+/).map(Number);
    if (start !== undefined && end !== undefined && pitch !== undefined && end > start && pitch > 0) notes.push({ start, end, pitch });
  }
  return notes.sort((a, b) => a.start - b.start);
}

const PPQ = 480;

function varLength(value: number): number[] {
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

/** A format 0 MIDI file at `bpm` (the notes' seconds become beats). */
export function notesToMidi(notes: Note[], bpm = 120): Uint8Array {
  const ticks = (seconds: number) => Math.round((seconds * bpm * PPQ) / 60);
  const events: { tick: number; order: number; data: number[] }[] = [];
  for (const n of notes) {
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const on = ticks(n.start);
    events.push({ tick: on, order: 1, data: [0x90, pitch, 96] });
    events.push({ tick: Math.max(on + 1, ticks(n.end)), order: 0, data: [0x80, pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  const micros = Math.round(60_000_000 / bpm);
  track.push(0, 0xff, 0x51, 3, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255);
  let last = 0;
  for (const e of events) { track.push(...varLength(e.tick - last), ...e.data); last = e.tick; }
  track.push(0, 0xff, 0x2f, 0);
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([...text("MThd"), ...u32(6), 0, 0, 0, 1, PPQ >> 8, PPQ & 255, ...text("MTrk"), ...u32(track.length), ...track]);
}
