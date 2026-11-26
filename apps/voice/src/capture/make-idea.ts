// A new idea from samples worked out on the page (a polish, a mix): written like a take.
import { analyse } from "./analyze";
import { shrink } from "./recorder";
import { defaultName, newId, openWriter, readAudio, saveIdea, type Idea } from "./store";
import { toInt16 } from "./wav";

export async function saveSamples(samples: Float32Array, rate: number, base: Partial<Idea> & { name: string }): Promise<Idea> {
  const id = newId();
  const writer = await openWriter(id, rate);
  const CHUNK = 32768;
  const bars: number[] = [];
  const barLength = Math.round(0.05 * rate);
  for (let at = 0; at < samples.length; at += CHUNK) writer.write(toInt16(samples.subarray(at, Math.min(samples.length, at + CHUNK))));
  for (let at = 0; at < samples.length; at += barLength) {
    let peak = 0;
    for (let i = at; i < Math.min(samples.length, at + barLength); i++) peak = Math.max(peak, Math.abs(samples[i]!));
    bars.push(peak);
  }
  await writer.close();
  const idea: Idea = {
    id, created: Date.now(), length: samples.length / rate, rate, starred: false, note: "", peaks: shrink(bars), markers: [], status: "saved", ...base,
    name: base.name || defaultName(),
  };
  await saveIdea(idea);
  void readAudio(idea).then(analyse).then(async (result) => { await saveIdea({ ...idea, ...result }); }).catch(() => {});
  return idea;
}

/** The layer over its idea: one recording out of the two, the layer moved earlier by the delay measured when it was recorded. */
export function mixDown(under: Float32Array, over: Float32Array, offsetSeconds: number, rate: number): Float32Array {
  const shift = Math.max(0, Math.round(offsetSeconds * rate));
  const length = Math.max(under.length, over.length - shift);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (under[i] ?? 0) + (over[i + shift] ?? 0);
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0.97) { const g = 0.97 / peak; for (let i = 0; i < length; i++) out[i] = out[i]! * g; }
  return out;
}

/** Same rate for two recordings (linear, good enough for a rough mix). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const out = new Float32Array(Math.round((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const at = (i * from) / to;
    const a = Math.floor(at);
    out[i] = (samples[a] ?? 0) * (1 - (at - a)) + (samples[a + 1] ?? samples[a] ?? 0) * (at - a);
  }
  return out;
}
