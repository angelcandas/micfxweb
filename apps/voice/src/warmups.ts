// Warm-ups (plan section 9, point 17): scales, slides and intervals made in any key, then
// sung and scored in Practice like a song. Each exercise goes round a few times, a semitone
// higher each time, with a soft chord to set each one off; the exercise itself is the guide
// voice (a sung "oo"), so the guide level brings it in and out like a song's voice.

export interface Exercise {
  id: string;
  name: string;
  /** Scale steps from the root, in semitones, each one beat... */
  steps: number[];
  /** ...or this many beats each (the same length as steps). */
  beats?: number[];
  /** Glide between the notes in the guide (a siren); the notes are still where it's scored. */
  glide?: boolean;
}

export const EXERCISES: Exercise[] = [
  { id: "five", name: "Five-note scale", steps: [0, 2, 4, 5, 7, 5, 4, 2, 0], beats: [1, 1, 1, 1, 1, 1, 1, 1, 2] },
  { id: "scale", name: "Major scale", steps: [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0], beats: [1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2] },
  { id: "arpeggio", name: "Arpeggio", steps: [0, 4, 7, 12, 7, 4, 0], beats: [1, 1, 1, 2, 1, 1, 2] },
  { id: "siren", name: "Siren", steps: [0, 7, 12, 7, 0], beats: [2, 1, 2, 1, 2], glide: true },
  { id: "intervals", name: "Intervals", steps: [0, 2, 0, 4, 0, 5, 0, 7, 0, 9, 0, 12, 0], beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2] },
  { id: "thirds", name: "Thirds", steps: [0, 4, 2, 5, 4, 7, 5, 9, 7, 11, 12], beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2] },
];

export const TEMPOS = { slow: 72, medium: 96, fast: 126 } as const;
export type Tempo = keyof typeof TEMPOS;

export interface WarmupSettings {
  exercise: string;
  /** The first time round's root (MIDI). */
  root: number;
  /** Times round, each a semitone higher. */
  rounds: number;
  tempo: Tempo;
}

export interface Note {
  start: number;
  end: number;
  midi: number;
}

export interface Warmup {
  name: string;
  key: string;
  notes: Note[];
  /** Each round's start and root, for its chord. */
  rounds: { start: number; root: number }[];
  seconds: number;
  /** The melody as Practice keeps it ("start end pitch" lines). */
  melody: string;
}

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const noteName = (midi: number) => `${NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;

/** The exercise's span in semitones (its highest step). */
export const span = (exercise: Exercise) => Math.max(...exercise.steps) - Math.min(...exercise.steps);

export function exerciseOf(id: string): Exercise {
  return EXERCISES.find((e) => e.id === id) ?? EXERCISES[0]!;
}

/**
 * The first root that keeps every round inside a singer's range (low..high MIDI), a little
 * in from the bottom; the middle of a typical range when there's none.
 */
export function rootFor(exercise: Exercise, rounds: number, range?: { low: number; high: number }): number {
  if (!range) return 55; // G3
  const top = range.high - span(exercise) - (rounds - 1);
  return Math.round(Math.max(range.low, Math.min(top, range.low + 2)));
}

export function makeWarmup(settings: WarmupSettings): Warmup {
  const exercise = exerciseOf(settings.exercise);
  const rounds = Math.max(1, Math.min(12, Math.round(settings.rounds)));
  const beat = 60 / TEMPOS[settings.tempo];
  const notes: Note[] = [];
  const starts: { start: number; root: number }[] = [];
  let time = 2 * beat; // the first chord first
  for (let round = 0; round < rounds; ++round) {
    const root = Math.round(settings.root) + round;
    starts.push({ start: time - 2 * beat, root });
    exercise.steps.forEach((step, i) => {
      const length = (exercise.beats?.[i] ?? 1) * beat;
      // A short breath between notes (a slide's notes join up).
      const gap = exercise.glide ? 0 : Math.min(0.12, length * 0.2);
      notes.push({ start: round3(time), end: round3(time + length - gap), midi: root + step });
      time += length;
    });
    time += 3 * beat; // a breath, then the next chord
  }
  const name = `${exercise.name} from ${noteName(settings.root)}`;
  return {
    name,
    key: `${NAMES[((Math.round(settings.root) % 12) + 12) % 12]} major`,
    notes,
    rounds: starts,
    seconds: round3(time),
    melody: notes.map((n) => `${n.start.toFixed(3)} ${n.end.toFixed(3)} ${n.midi.toFixed(2)}`).join("\n") + "\n",
  };
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** The guide: the exercise sung on "oo" (a soft, breathy tone with a little vibrato). Mono. */
export function renderGuide(warmup: Warmup, rate: number, glide = false): Float32Array {
  const out = new Float32Array(Math.ceil((warmup.seconds + 0.5) * rate));
  const notes = warmup.notes;
  let phase = 0;
  for (let k = 0; k < notes.length; ++k) {
    const note = notes[k]!;
    const next = notes[k + 1];
    const from = Math.round(note.start * rate);
    const to = Math.min(out.length, Math.round(note.end * rate));
    const joined = glide && next && Math.abs(next.start - note.end) < 1e-3;
    for (let i = from; i < to; ++i) {
      const t = (i - from) / rate;
      const length = (to - from) / rate;
      // A siren slides into the next note over the note's last third.
      let midi = note.midi;
      if (joined && t > length * 0.66) midi += (next!.midi - note.midi) * ((t - length * 0.66) / (length * 0.34));
      const vibrato = 0.25 * Math.min(1, t / 0.4) * Math.sin(2 * Math.PI * 5.2 * t);
      phase += (2 * Math.PI * hz(midi + vibrato / 1)) / rate;
      const attack = Math.min(1, t / 0.06);
      const release = joined ? 1 : Math.min(1, (length - t) / 0.08);
      const tone = Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase) + 0.05 * Math.sin(4 * phase);
      out[i] = 0.22 * tone * attack * release;
    }
  }
  return out;
}

/** The backing: a soft keyboard chord to start each round (root, third, fifth, and the root below). Stereo. */
export function renderBacking(warmup: Warmup, rate: number): [Float32Array, Float32Array] {
  const length = Math.ceil((warmup.seconds + 0.5) * rate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const round of warmup.rounds) {
    const chord = [round.root - 12, round.root, round.root + 4, round.root + 7];
    const from = Math.round(round.start * rate);
    const seconds = 2.4;
    chord.forEach((midi, c) => {
      const f = hz(midi);
      const pan = 0.5 + (c - 1.5) * 0.15;
      for (let i = 0; i < seconds * rate && from + i < length; ++i) {
        const t = i / rate;
        const env = Math.min(1, t / 0.01) * Math.exp(-t * 1.6);
        const v = 0.07 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 3));
        left[from + i]! += v * (1 - pan) * 2;
        right[from + i]! += v * pan * 2;
      }
    });
  }
  return [left, right];
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}
