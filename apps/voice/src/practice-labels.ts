// Coach's cues on the notes (the desktop's Practice labels): a reusable library of
// icon + colour + text, and the labels put on notes and phrases of a song.

export interface Label {
  id: string;
  text: string;
  icon: string;
  colour: string;
}

/** A song's labels: the note or phrase start (in the song as recorded) and its cues. */
export interface Annotation {
  kind: "note" | "phrase";
  time: number;
  labels: Label[];
}

export const LABELS = "labels.json";
export const EDITED = "melody-edited.txt";

/** The cues a vocal coach writes on a lead sheet (the desktop's). */
export const DEFAULT_LABELS: Label[] = [
  { id: "grit", text: "Grit", icon: "🔥", colour: "#ff7a5a" },
  { id: "breath", text: "Breathe", icon: "💨", colour: "#5aa9ff" },
  { id: "prepare", text: "Prepare position", icon: "🎯", colour: "#ffc94d" },
  { id: "slower", text: "Slower", icon: "🐢", colour: "#3fd9c6" },
  { id: "piano", text: "Piano (soft)", icon: "p", colour: "#8fb4ff" },
  { id: "forte", text: "Forte (loud)", icon: "f", colour: "#ff9a5a" },
  { id: "belt", text: "Belt", icon: "📢", colour: "#ff6b8a" },
  { id: "head", text: "Head voice", icon: "☁", colour: "#b79bff" },
  { id: "vibrato", text: "Vibrato", icon: "〰", colour: "#7be0a0" },
  { id: "straight", text: "Straight tone", icon: "—", colour: "#c8cfdd" },
  { id: "slide", text: "Slide in", icon: "↗", colour: "#e0b45a" },
  { id: "accent", text: "Accent", icon: ">", colour: "#ff7a90" },
];

const COLOUR = /^#[0-9a-fA-F]{6}$/;

/** A label from anything the page sent: trimmed, with a colour that is one (or a default). */
export function cleanLabel(value: unknown): Label | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const text = String(v.text ?? "").trim().slice(0, 40);
  if (!text) return undefined;
  const colour = String(v.colour ?? "").trim();
  return { id: String(v.id ?? "").trim(), text, icon: Array.from(String(v.icon ?? "").trim()).slice(0, 4).join(""), colour: COLOUR.test(colour) ? colour : "#8c7bff" };
}

export function newLabelId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/** The library as kept (a list), or the defaults when none was ever saved. */
export function libraryFrom(saved: unknown): Label[] {
  if (!Array.isArray(saved)) return DEFAULT_LABELS.map((l) => ({ ...l }));
  return saved.map(cleanLabel).filter((l): l is Label => Boolean(l));
}

/** The library the page sent to keep: every label with an id. */
export function libraryToKeep(list: unknown): Label[] {
  if (!Array.isArray(list)) return [];
  return list.map(cleanLabel).filter((l): l is Label => Boolean(l)).map((l) => ({ ...l, id: l.id || newLabelId() }));
}

export function parseAnnotations(text: string | undefined): Annotation[] {
  try {
    const list = JSON.parse(text ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    const out: Annotation[] = [];
    for (const item of list) {
      const time = Number(item?.time);
      const labels = Array.isArray(item?.labels) ? (item.labels as unknown[]).map(cleanLabel).filter((l): l is Label => Boolean(l)) : [];
      if (Number.isFinite(time) && labels.length) out.push({ kind: item.kind === "phrase" ? "phrase" : "note", time, labels });
    }
    return out.sort((a, b) => a.time - b.time);
  } catch {
    return [];
  }
}

/**
 * The note or phrase start nearest `time` (within 50 ms), or undefined. `notes` is the song's
 * flat notes (start, end, midi, phrase) and `phrases` its (start, end) pairs.
 */
export function snapStart(kind: "note" | "phrase", time: number, notes: number[], phrases: number[]): number | undefined {
  const stride = kind === "phrase" ? 2 : 4;
  const list = kind === "phrase" ? phrases : notes;
  let best: number | undefined;
  let distance = 0.05;
  for (let i = 0; i + 1 < list.length; i += stride) {
    const d = Math.abs(list[i]! - time);
    if (d < distance) {
      distance = d;
      best = list[i];
    }
  }
  return best;
}

/** Puts (or, with no labels, takes off) the labels of one note or phrase; the list stays in time order. */
export function annotate(all: Annotation[], kind: "note" | "phrase", time: number, labels: Label[]): Annotation[] {
  const rest = all.filter((a) => !(a.kind === kind && Math.abs(a.time - time) < 1e-3));
  if (labels.length) rest.push({ kind, time, labels });
  return rest.sort((a, b) => a.time - b.time);
}

/** A flat list of notes (start, end, midi) as the melody file: one note a line. */
export function melodyText(flat: unknown): string {
  if (!Array.isArray(flat)) return "";
  const notes: { start: number; end: number; pitch: number }[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const start = Number(flat[i]);
    const end = Number(flat[i + 1]);
    const pitch = Number(flat[i + 2]);
    if ([start, end, pitch].every(Number.isFinite) && start >= 0 && end - start >= 0.02 && pitch >= 20 && pitch <= 110) notes.push({ start, end, pitch });
  }
  notes.sort((a, b) => a.start - b.start);
  // (a note can't run into the next: cut it back)
  for (let i = 0; i + 1 < notes.length; ++i) notes[i]!.end = Math.min(notes[i]!.end, notes[i + 1]!.start);
  return notes
    .filter((n) => n.end - n.start >= 0.02)
    .map((n) => `${n.start.toFixed(3)} ${n.end.toFixed(3)} ${n.pitch.toFixed(2)}\n`)
    .join("");
}
