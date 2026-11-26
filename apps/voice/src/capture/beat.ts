// A scratch beat under an idea: drums made from a few sine sweeps and bursts of noise,
// at the idea's tempo, so a hummed tune can be heard with something under it.

export const BEAT_STYLES = ["Basic", "Four on the floor", "Half time", "Shuffle"] as const;
export type BeatStyle = (typeof BEAT_STYLES)[number];

type Hit = "kick" | "snare" | "hat";

/** One bar of 4/4 in 16ths: [step, hit]. */
function pattern(style: BeatStyle): [number, Hit][] {
  const hits: [number, Hit][] = [];
  const hats = (every: number) => { for (let s = 0; s < 16; s += every) hits.push([s, "hat"]); };
  switch (style) {
    case "Four on the floor": [0, 4, 8, 12].forEach((s) => hits.push([s, "kick"])); [4, 12].forEach((s) => hits.push([s, "snare"])); for (let s = 2; s < 16; s += 4) hits.push([s, "hat"]); break;
    case "Half time": hits.push([0, "kick"], [10, "kick"], [8, "snare"]); hats(2); break;
    case "Shuffle": [0, 8].forEach((s) => hits.push([s, "kick"])); [4, 12].forEach((s) => hits.push([s, "snare"])); for (let s = 0; s < 16; s += 4) hits.push([s, "hat"], [s + 3, "hat"]); break;
    default: [0, 8, 10].forEach((s) => hits.push([s, "kick"])); [4, 12].forEach((s) => hits.push([s, "snare"])); hats(2);
  }
  return hits;
}

function addHit(out: Float32Array, at: number, hit: Hit, rate: number) {
  const length = Math.round(rate * (hit === "kick" ? 0.28 : hit === "snare" ? 0.2 : 0.06));
  let noise = 12345 + at;
  const rand = () => { noise = (noise * 1664525 + 1013904223) >>> 0; return noise / 2147483648 - 1; };
  let phase = 0;
  let lowpass = 0;
  for (let i = 0; i < length && at + i < out.length; i++) {
    const t = i / rate;
    let v = 0;
    if (hit === "kick") {
      phase += (2 * Math.PI * (45 + 110 * Math.exp(-t * 28))) / rate;
      v = Math.sin(phase) * Math.exp(-t * 11) * 0.9;
    } else if (hit === "snare") {
      phase += (2 * Math.PI * 190) / rate;
      v = (rand() * 0.5 + Math.sin(phase) * 0.35) * Math.exp(-t * 22);
    } else {
      const n = rand();
      lowpass += (n - lowpass) * 0.45;
      v = (n - lowpass) * 0.22 * Math.exp(-t * 70); // high-passed
    }
    out[at + i] = out[at + i]! + v;
  }
}

/** `seconds` of the beat at `bpm`, starting on the first beat. */
export function renderBeat(style: BeatStyle, bpm: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const step = (60 / bpm / 4) * rate; // a 16th
  const bar = pattern(style);
  const swing = style === "Shuffle";
  for (let barStart = 0; barStart * step * 16 < out.length; barStart++) {
    for (const [s, hit] of bar) {
      const at = Math.round((barStart * 16 + s) * step + (swing && s % 2 === 1 ? step * 0.12 : 0));
      if (at < out.length) addHit(out, at, hit, rate);
    }
  }
  // Where a kick and a snare fall together they'd clip: the whole beat is set to a peak of 0.8.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i]! / peak) * 0.8;
  return out;
}
