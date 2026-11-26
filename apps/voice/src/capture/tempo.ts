// A tempo guess for an idea: the beat of the loudness changes (autocorrelation of the onset
// curve over 60 to 180 BPM). A hummed melody with no pulse gives nothing, so it only answers
// when the pulse clearly stands out.

export interface TempoGuess { bpm: number; confidence: number }

export function estimateTempo(samples: Float32Array, rate: number): TempoGuess | undefined {
  const hop = Math.round(rate / 100); // 100 curve values a second
  const count = Math.floor(samples.length / hop);
  if (count < 600) return undefined; // under 6 s
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += samples[j]! * samples[j]!;
    energy[i] = Math.log(1e-6 + sum / hop);
  }
  const onset = new Float32Array(count);
  let mean = 0;
  for (let i = 1; i < count; i++) { onset[i] = Math.max(0, energy[i]! - energy[i - 1]!); mean += onset[i]!; }
  mean /= count;
  for (let i = 0; i < count; i++) onset[i] = onset[i]! - mean;
  const lagFor = (bpm: number) => Math.round((60 / bpm) * 100);
  const at = (lag: number) => {
    let sum = 0;
    for (let i = lag; i < count; i++) sum += onset[i]! * onset[i - lag]!;
    return sum / (count - lag);
  };
  const zero = at(0);
  if (zero <= 0) return undefined;
  let best = 0, bestLag = 0, total = 0, n = 0;
  for (let lag = lagFor(180); lag <= lagFor(60); lag++) {
    const value = at(lag) / zero;
    total += Math.max(0, value); n++;
    if (value > best) { best = value; bestLag = lag; }
  }
  if (!bestLag) return undefined;
  const confidence = best / Math.max(1e-6, total / n);
  let bpm = 6000 / bestLag;
  // A half or double of the beat reads better in the 80 to 160 range.
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return confidence >= 3 && best >= 0.25 ? { bpm: Math.round(bpm), confidence } : undefined;
}
