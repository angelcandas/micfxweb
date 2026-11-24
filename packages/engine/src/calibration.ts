// Latency calibration (plan section 9, point 2): clicks are played and heard back through the
// mic, sample-aligned on the audio thread, so the real round trip of this device (Bluetooth
// included) is measured instead of guessed from what the browser reports.

export const CALIBRATION_CLICKS = 8;
const CLICK_GAP_SECONDS = 0.45;
const LEAD_SECONDS = 0.3;
const CLICK_SECONDS = 0.004;
/** The longest round trip looked for (Bluetooth can pass 300 ms). */
const MAX_SECONDS = 0.4;

/** The click: a short burst of a few cycles at 2 kHz, Hann-shaped. */
export function calibrationClick(rate: number): Float32Array {
  const n = Math.max(8, Math.round(CLICK_SECONDS * rate));
  return Float32Array.from({ length: n }, (_, i) => 0.7 * Math.sin((2 * Math.PI * 2000 * i) / rate) * Math.sin((Math.PI * i) / n) ** 2);
}

/** On the audio thread: plays the clicks and keeps the mic, then hands both over. */
export class Calibrator {
  private readonly click: Float32Array;
  readonly clicks: number[];
  private readonly mic: Float32Array;
  private at = 0;

  constructor(readonly rate: number) {
    this.click = calibrationClick(rate);
    const gap = Math.round(CLICK_GAP_SECONDS * rate);
    const lead = Math.round(LEAD_SECONDS * rate);
    this.clicks = Array.from({ length: CALIBRATION_CLICKS }, (_, k) => lead + k * gap);
    this.mic = new Float32Array(lead + CALIBRATION_CLICKS * gap + Math.round(MAX_SECONDS * rate));
  }

  get done(): boolean {
    return this.at >= this.mic.length;
  }

  /** Replaces the output with the clicks (nothing else plays) and keeps the mic. */
  process(left: Float32Array, right: Float32Array, mic: Float32Array, frames: number): void {
    left.fill(0, 0, frames);
    if (right !== left) right.fill(0, 0, frames);
    for (let i = 0; i < frames && this.at + i < this.mic.length; ++i) {
      const t = this.at + i;
      this.mic[t] = mic[i] ?? 0;
      for (const start of this.clicks) {
        const k = t - start;
        if (k >= 0 && k < this.click.length) {
          left[i] = this.click[k]!;
          if (right !== left) right[i] = this.click[k]!;
        }
      }
    }
    this.at += frames;
  }

  result(): { mic: Float32Array; clicks: number[] } {
    return { mic: this.mic, clicks: this.clicks };
  }
}

export interface RoundTrip {
  /** Frames from a click going out to it coming back in, or undefined when it wasn't heard. */
  frames?: number;
  /** How alike the clicks' measures were and how far above the noise (0..1). */
  confidence: number;
  /** Each click's measure (frames), undefined where one wasn't heard. */
  each: (number | undefined)[];
}

/**
 * Finds each click in the mic by matching its shape, the first strong match after it went out;
 * the round trip is the median of those that agree.
 */
export function measureRoundTrip(mic: Float32Array, clicks: number[], rate: number): RoundTrip {
  const click = calibrationClick(rate);
  const max = Math.round(MAX_SECONDS * rate);
  const energy = click.reduce((sum, v) => sum + v * v, 0);
  const each: (number | undefined)[] = [];
  for (const start of clicks) {
    const scores = new Float32Array(max);
    let best = 0;
    for (let lag = 0; lag < max; ++lag) {
      const at = start + lag;
      if (at + click.length > mic.length) break;
      let dot = 0;
      let power = 0;
      for (let i = 0; i < click.length; ++i) {
        const v = mic[at + i]!;
        dot += v * click[i]!;
        power += v * v;
      }
      // Normalised: shape, not loudness.
      const score = power > 1e-12 ? dot / Math.sqrt(power * energy) : 0;
      scores[lag] = score;
      best = Math.max(best, score);
    }
    if (best < 0.5) {
      each.push(undefined);
      continue;
    }
    // The first peak close to the best: the direct sound, not a later echo of it.
    // The burst's neighbouring cycles match nearly as well: the best within a few cycles of
    // the first strong match is the click itself.
    let first = 0;
    while (first < max && scores[first]! < best * 0.6) ++first;
    const span = Math.round((3 * rate) / 2000);
    let lag = first;
    for (let k = first; k < Math.min(max, first + span); ++k) if (scores[k]! > scores[lag]!) lag = k;
    each.push(lag);
  }
  const heard = each.filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  if (heard.length < Math.ceil(clicks.length / 2)) return { confidence: heard.length / clicks.length / 2, each };
  const median = heard[Math.floor(heard.length / 2)]!;
  const agree = heard.filter((v) => Math.abs(v - median) <= Math.max(2, rate * 0.001));
  const confidence = (agree.length / clicks.length) * Math.min(1, heard.length / clicks.length);
  return { frames: agree.length >= Math.ceil(clicks.length / 2) ? median : undefined, confidence, each };
}
