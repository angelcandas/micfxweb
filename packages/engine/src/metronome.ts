// The click (plan section 9, point 3): on the beat of the transport while it plays, on its
// own clock when it doesn't, and through a count-in before a take. Added to what you hear
// after the recorder has taken the voice, so it's never in a take.

export interface MetronomeSettings {
  on?: boolean;
  bpm?: number;
  beatsPerBar?: number;
  /** 0..1 */
  volume?: number;
}

const CLICK_SECONDS = 0.035;

export class Metronome {
  on = false;
  bpm = 120;
  beatsPerBar = 4;
  volume = 0.6;
  /** Where beat 1 sits on the transport (frames): a take's start after its count-in. */
  anchor = 0;
  private free = 0; // frames on its own clock
  private lastBeat = Number.NaN;
  private ring = 0; // frames left of the click sounding
  private phase = 0;
  private step = 0;
  private level = 0;
  private readonly decay: number;

  constructor(readonly sampleRate: number) {
    this.decay = Math.exp(-1 / ((CLICK_SECONDS / 5) * sampleRate));
  }

  set(settings: MetronomeSettings): void {
    if (settings.on !== undefined) {
      if (settings.on && !this.on) {
        this.free = 0;
        this.lastBeat = Number.NaN;
      }
      this.on = settings.on;
    }
    if (settings.bpm !== undefined && Number.isFinite(settings.bpm)) this.bpm = Math.max(30, Math.min(300, settings.bpm));
    if (settings.beatsPerBar !== undefined && Number.isFinite(settings.beatsPerBar)) this.beatsPerBar = Math.max(1, Math.min(16, Math.round(settings.beatsPerBar)));
    if (settings.volume !== undefined && Number.isFinite(settings.volume)) this.volume = Math.max(0, Math.min(1, settings.volume));
  }

  get beatFrames(): number {
    return (60 / this.bpm) * this.sampleRate;
  }

  /** A count-in of `bars` in frames. */
  countInFrames(bars: number): number {
    return Math.round(bars * this.beatsPerBar * this.beatFrames);
  }

  /**
   * Adds the click to `frames` of left/right. `time` is where the block starts on the beat
   * grid (frames from beat 1, negative in a count-in), or undefined to run free; `audible`
   * when it should sound even if it's off (a count-in).
   */
  process(left: Float32Array, right: Float32Array, offset: number, frames: number, time: number | undefined, audible = this.on): void {
    if (!audible) {
      this.lastBeat = Number.NaN;
      this.ring = 0;
      return;
    }
    const beat = this.beatFrames;
    const start = time ?? this.free;
    for (let i = 0; i < frames; ++i) {
      const t = start + i;
      const index = Math.floor(t / beat);
      if (index !== this.lastBeat) {
        // A new beat: only right on it (a seek that lands mid-beat waits for the next one).
        if (t - index * beat < 1) {
          const accent = ((index % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar === 0;
          this.step = (2 * Math.PI * (accent ? 1760 : 1175)) / this.sampleRate;
          this.level = this.volume * (accent ? 0.5 : 0.32);
          this.phase = 0;
          this.ring = Math.round(CLICK_SECONDS * this.sampleRate);
        }
        this.lastBeat = index;
      }
      if (this.ring > 0) {
        const s = this.level * Math.sin(this.phase);
        this.phase += this.step;
        this.level *= this.decay;
        --this.ring;
        left[offset + i]! += s;
        if (right !== left) right[offset + i]! += s;
      }
    }
    if (time === undefined) this.free += frames;
  }
}
