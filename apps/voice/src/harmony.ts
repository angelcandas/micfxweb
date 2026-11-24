// Duet mode (plan section 9, point 20): a song's second part to sing, a harmony a third above
// or below the melody in the song's key, scored on its own (its passes kept apart from the
// lead's). One singer can take the lead and another the harmony, each scoring their part.

export type Part = "lead" | "above" | "below";
export const PARTS: { id: Part; name: string }[] = [
  { id: "lead", name: "Lead" },
  { id: "above", name: "Harmony above" },
  { id: "below", name: "Harmony below" },
];

const NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** "G major", "F♯ minor", "Bb major" → tonic pitch class and scale; undefined when unknown. */
export function parseKey(key: string): { tonic: number; scale: number[] } | undefined {
  const match = /^([A-G])([#♯b♭]?)\s*(major|minor)/i.exec(key.trim());
  if (!match) return undefined;
  const accidental = match[2] === "#" || match[2] === "♯" ? 1 : match[2] === "b" || match[2] === "♭" ? -1 : 0;
  return { tonic: (NAMES[match[1]!.toUpperCase()]! + accidental + 12) % 12, scale: match[3]!.toLowerCase() === "minor" ? MINOR : MAJOR };
}

/** The note a diatonic third above (+1) or below (-1) `midi` in the key; the cents stay. */
export function thirdOf(midi: number, key: { tonic: number; scale: number[] }, direction: 1 | -1): number {
  const whole = Math.round(midi);
  const cents = midi - whole;
  const rel = (((whole - key.tonic) % 12) + 12) % 12;
  // The scale degree at or just under the note (a note outside the key moves with it).
  let degree = 0;
  for (let d = 0; d < 7; ++d) if (key.scale[d]! <= rel) degree = d;
  const octave = Math.floor((whole - key.tonic) / 12);
  const at = (d: number) => key.tonic + 12 * (octave + Math.floor(d / 7)) + key.scale[((d % 7) + 7) % 7]!;
  const offset = whole - at(degree);
  return at(degree + 2 * direction) + offset + cents;
}

/** The melody text ("start end pitch" lines) for a part. */
export function partMelody(melody: string, keyName: string, part: Part): string {
  const key = parseKey(keyName);
  if (part === "lead" || !key) return melody;
  return melody
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 3) return line;
      const pitch = Number(parts[2]);
      if (!Number.isFinite(pitch) || pitch <= 0) return line;
      return `${parts[0]} ${parts[1]} ${thirdOf(pitch, key, part === "above" ? 1 : -1).toFixed(2)}`;
    })
    .join("\n");
}

/** Where a part's passes are kept beside the song. */
export const historyFile = (part: Part) => (part === "lead" ? "history.json" : `history-${part}.json`);
