// Range finder (plan section 9, point 16): your lowest and highest comfortable notes, from a
// short test, kept in this browser; each song then suggests the key that fits your voice.

export interface VoiceRange {
  low: number;
  high: number;
  at: number;
}

const KEY = "micfx.range";

export function readRange(): VoiceRange | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as VoiceRange | null;
    return value && Number.isFinite(value.low) && Number.isFinite(value.high) && value.high > value.low ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeRange(range: VoiceRange | undefined) {
  try {
    if (range) localStorage.setItem(KEY, JSON.stringify(range));
    else localStorage.removeItem(KEY);
  } catch {
    // not kept
  }
}

/**
 * The note held in a few seconds of pitch readings (MIDI, 0 where there was none): the
 * middle of the longest steady stretch, so a scoop into the note or a crack at the end
 * doesn't count. Undefined when nothing was held for `minReadings`.
 */
export function heldNote(readings: number[], minReadings = 15): number | undefined {
  let best: number[] = [];
  let run: number[] = [];
  for (const midi of readings) {
    if (midi > 20 && midi < 110 && (!run.length || Math.abs(midi - median(run)) < 1.2)) run.push(midi);
    else {
      if (run.length > best.length) best = run;
      run = midi > 20 && midi < 110 ? [midi] : [];
    }
  }
  if (run.length > best.length) best = run;
  return best.length >= minReadings ? Math.round(median(best) * 10) / 10 : undefined;
}

/**
 * The key change (semitones, -maxShift..maxShift) that puts a melody (lowest..highest MIDI)
 * in a singer's range: nothing out of range first, then the melody's middle near the
 * range's middle, then as small a change as that allows.
 */
export function suggestShift(song: { lowest: number; highest: number }, range: { low: number; high: number }, maxShift = 6): number {
  let best = 0;
  let bestCost = Infinity;
  const middle = (range.low + range.high) / 2;
  for (let s = -maxShift; s <= maxShift; ++s) {
    const low = song.lowest + s;
    const high = song.highest + s;
    const out = Math.max(0, range.low - low) + Math.max(0, high - range.high);
    const cost = out * 10 + Math.abs((low + high) / 2 - middle) * 0.5 + Math.abs(s) * 0.6;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = s;
    }
  }
  return best;
}

/** "1 octave and 4 semitones" for a span. */
export function spanText(semitones: number): string {
  const s = Math.round(semitones);
  const octaves = Math.floor(s / 12);
  const rest = s % 12;
  const parts = [octaves ? `${octaves} octave${octaves > 1 ? "s" : ""}` : "", rest ? `${rest} semitone${rest > 1 ? "s" : ""}` : ""].filter(Boolean);
  return parts.join(" and ") || "one note";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
