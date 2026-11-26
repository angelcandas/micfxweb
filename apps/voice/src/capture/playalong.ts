// Play along with an idea: a click at its tempo and a quiet drone on its key, kept in time
// with the idea's own playback (they follow its play head and its speed).

const NOTES: Record<string, number> = { C: 0, "C#": 1, "D♭": 1, Db: 1, D: 2, "D#": 3, "E♭": 3, Eb: 3, E: 4, F: 5, "F#": 6, "G♭": 6, Gb: 6, G: 7, "G#": 8, "A♭": 8, Ab: 8, A: 9, "A#": 10, "B♭": 10, Bb: 10, B: 11 };

/** "A minor", "E♭ major" -> the tonic's pitch class and whether it's minor; undefined when the text isn't a key. */
export function parseKey(text: string | undefined): { tonic: number; minor: boolean } | undefined {
  const match = /^\s*([A-G][#♭b]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(text ?? "");
  if (!match) return undefined;
  const name = match[1]![0]!.toUpperCase() + match[1]!.slice(1);
  const tonic = NOTES[name];
  return tonic === undefined ? undefined : { tonic, minor: /^m(in(or)?)?$/i.test(match[2] ?? "") };
}

/** A note's frequency near the bass: the tonic between C2 and B2. */
export const droneHz = (tonic: number) => 65.406 * 2 ** (tonic / 12);

export class PlayAlong {
  clickOn = false;
  droneOn = false;
  bpm = 100;
  key: { tonic: number; minor: boolean } | undefined;
  private context: AudioContext | undefined;
  private drone: { stop(): void } | undefined;
  private nextBeat = 0;

  private ctx(): AudioContext {
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    return this.context;
  }

  /** The idea started or sought to `at` seconds: clicks begin from the next beat. */
  seek(at: number) {
    this.nextBeat = Math.ceil((at * this.bpm) / 60 - 1e-6);
  }

  /** Called every frame while the idea plays: schedules the clicks that fall in the next 0.25 s. */
  tick(at: number, rate: number) {
    if (!this.clickOn || this.bpm <= 0) return;
    const context = this.ctx();
    const beatSeconds = 60 / this.bpm;
    while (this.nextBeat * beatSeconds < at + 0.25 * rate) {
      const when = context.currentTime + Math.max(0, (this.nextBeat * beatSeconds - at) / rate);
      if (this.nextBeat * beatSeconds >= at - 0.02) this.click(context, when, this.nextBeat % 4 === 0);
      this.nextBeat++;
    }
  }

  private click(context: AudioContext, when: number, accent: boolean) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(context.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  setDrone(on: boolean) {
    this.droneOn = on;
    this.syncDrone(false);
  }

  /** The drone sounds while the idea plays. */
  syncDrone(playing: boolean) {
    this.drone?.stop();
    this.drone = undefined;
    if (!this.droneOn || !playing || !this.key) return;
    const context = this.ctx();
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.09, context.currentTime + 0.4);
    gain.connect(context.destination);
    const hz = droneHz(this.key.tonic);
    // The tonic and the fifth, a soft triangle each: it says where "home" is without a chord's mood.
    const oscillators = [hz, hz * 1.5, hz * 2].map((f, i) => {
      const o = context.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = context.createGain();
      g.gain.value = i === 0 ? 1 : 0.45;
      o.connect(g).connect(gain);
      o.start();
      return o;
    });
    this.drone = {
      stop: () => {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.15);
        setTimeout(() => { oscillators.forEach((o) => { try { o.stop(); } catch { /* stopped */ } }); gain.disconnect(); }, 250);
      },
    };
  }

  close() {
    this.drone?.stop();
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
