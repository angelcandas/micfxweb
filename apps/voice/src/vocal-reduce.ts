// "Cancel voice": the backing of a song when it isn't split into stems. A voice is mixed in the
// middle of a stereo song, so what is the same in both channels is mostly the voice (and the
// bass and kick); what differs between them is the band around it. The difference of the two
// channels is the backing; the low end of the middle is added back so it keeps its weight.
type Stereo = [Float32Array, Float32Array];

/** Frequency (Hz) below which the middle (bass, kick) is kept. */
const KEEP_BELOW = 140;

/** The song with its centred voice taken down; mono songs (nothing to subtract) come back as they were. */
export function reduceVoice(song: Stereo, rate: number): { audio: Stereo; reduced: boolean } {
  const [left, right] = song;
  if (left === right) return { audio: [left, right], reduced: false };
  const n = Math.min(left.length, right.length);
  // A song that is the same in both channels has no side to keep.
  let side = 0;
  let mid = 0;
  for (let i = 0; i < n; i += 7) {
    const s = left[i]! - right[i]!;
    const m = left[i]! + right[i]!;
    side += s * s;
    mid += m * m;
  }
  if (side < mid * 1e-6) return { audio: [left, right], reduced: false };

  const a = 1 - Math.exp((-2 * Math.PI * KEEP_BELOW) / rate);
  let low1 = 0;
  let low2 = 0;
  const out: Stereo = [new Float32Array(n), new Float32Array(n)];
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const m = (left[i]! + right[i]!) * 0.5;
    const s = (left[i]! - right[i]!) * 0.5;
    low1 += a * (m - low1);
    low2 += a * (low1 - low2);
    // The side, widened back a little, with the bass in the middle.
    const l = s * 1.4 + low2;
    const r = -s * 1.4 + low2;
    out[0][i] = l;
    out[1][i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < n; i++) {
      out[0][i]! *= g;
      out[1][i]! *= g;
    }
  }
  return { audio: out, reduced: true };
}
