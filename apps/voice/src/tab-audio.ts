// Sing along to a browser tab (plan section 9, point 9): a YouTube or Spotify tab's sound
// as the backing, through the browser's tab sharing. It plays the desktop's "Computer audio"
// panel (ui/computer.js, native function "computerAudio"): a switch, a level, a meter, and
// whether takes get the tab under the voice.
//
// The tab is heard once, through MicFX (the browser mutes it on the speakers), so it lines
// up with the voice and the panic button silences it too. Takes keep the tab beside the
// voice; "In recordings" mixes it under the voice, lined up with what you heard.
//
// Chrome and Edge share a tab's sound. Firefox and Safari share the picture only, so there
// the panel says to load the song as a backing track instead.
import type { LiveAudio } from "./audio";

const KEY = "micfx.tab";
const DEFAULT_LEVEL = -6;

export interface TabAudioState {
  available: boolean;
  on: boolean;
  /** dB, -60 (off) to +12. */
  level: number;
  source: string;
  sources: { id: string; name: string }[];
  inRecordings: boolean;
  muteOnSpeakers: boolean;
  system: boolean;
  /** The tab's title, while one is shared. */
  tab?: string;
  error?: string;
}

/** Whether this browser shares a tab's sound (Chromium has CaptureController; the others share no audio). */
export function sharesTabAudio(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function" && "CaptureController" in window;
}

export const TAB_AUDIO_NOTE =
  "Pick the tab with the song and keep “Also share tab audio” on. Chrome and Edge share a tab's sound; " +
  "Firefox and Safari share only the picture, so there load the song as a backing track instead. " +
  "You hear the tab through MicFX, in time with your voice; it comes back on the speakers when you stop.";

export class TabAudio {
  /** The tab stopped sharing (from the browser's own "Stop sharing"). */
  onEnded: () => void = () => {};
  private stream: MediaStream | undefined;
  private prefs: { level: number; inRecordings: boolean };

  constructor(
    private readonly audio: LiveAudio,
    private readonly startAudio: () => Promise<unknown>,
  ) {
    this.prefs = { level: DEFAULT_LEVEL, inRecordings: true, ...read() };
    audio.setLiveGain(gainOf(this.prefs.level));
  }

  get on(): boolean {
    return Boolean(this.stream?.getAudioTracks().some((track) => track.readyState === "live"));
  }

  /** Whether takes get the tab mixed under the voice. */
  get inRecordings(): boolean {
    return this.prefs.inRecordings;
  }

  state(error?: string): TabAudioState {
    const track = this.stream?.getVideoTracks()[0] ?? this.stream?.getAudioTracks()[0];
    return {
      available: typeof navigator.mediaDevices?.getDisplayMedia === "function",
      on: this.on,
      level: this.prefs.level,
      source: "tab",
      sources: [{ id: "tab", name: sharesTabAudio() ? "A browser tab" : "A browser tab (Chrome and Edge)" }],
      inRecordings: this.prefs.inRecordings,
      muteOnSpeakers: true,
      system: false,
      ...(this.on && track?.label ? { tab: track.label } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** The panel's "set": on/off, level, in recordings. Turning on asks which tab (needs the click). */
  async set(changes: { on?: boolean; level?: number; inRecordings?: boolean; source?: string }): Promise<TabAudioState> {
    if (typeof changes.level === "number" && Number.isFinite(changes.level)) {
      this.prefs.level = Math.max(-60, Math.min(12, changes.level));
      this.audio.setLiveGain(gainOf(this.prefs.level));
    }
    if (typeof changes.inRecordings === "boolean") this.prefs.inRecordings = changes.inRecordings;
    write(this.prefs);
    if (changes.on === false) this.stop();
    if (changes.on === true && !this.on) {
      try {
        await this.share();
      } catch (error) {
        return this.state(errorText(error));
      }
    }
    return this.state();
  }

  /** The meters event's "computer": the tab's peak while it's on. */
  reading(): { peak: number; receiving: boolean } | undefined {
    if (!this.on) return undefined;
    const peak = this.audio.livePeak();
    return { peak: peak ?? 0, receiving: (peak ?? 0) > 1e-4 };
  }

  stop(): void {
    const stream = this.stream;
    this.stream = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    this.audio.setLiveInput(undefined);
  }

  private async share() {
    if (!sharesTabAudio()) throw new Error("no-tab-audio");
    // First, while the click still counts: the browser's tab picker.
    const options = {
      video: { displaySurface: "browser" },
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "exclude",
      // The whole computer's sound would include MicFX itself and howl.
      systemAudio: "exclude",
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(options);
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("no-audio");
    }
    // Only the sound is wanted; the picture is kept (stopping it can end the share) but unused.
    await this.startAudio();
    if (!this.audio.running) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("MicFX needs the microphone first.");
    }
    this.stop();
    this.stream = stream;
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => {
        if (this.stream !== stream || this.on) return;
        this.stop();
        this.onEnded();
      });
    this.audio.setLiveInput(stream);
  }
}

/**
 * The take with the tab under the voice, lined up with what you heard: the voice track goes
 * `latencyFrames` earlier on the timeline than the tab came in, so the tab moves later by as
 * much in the take.
 */
export function mixBacking(voice: [Float32Array, Float32Array], backing: [Float32Array, Float32Array], gain: number, latencyFrames: number): [Float32Array, Float32Array] {
  const shift = Math.max(0, Math.round(latencyFrames));
  return voice.map((channel, c) => {
    const out = channel.slice();
    const tab = backing[c]!;
    for (let i = shift; i < out.length; ++i) out[i]! += (tab[i - shift] ?? 0) * gain;
    return out;
  }) as [Float32Array, Float32Array];
}

export function gainOf(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "no-tab-audio") return "This browser shares a tab's picture but not its sound. Use Chrome or Edge, or load the song as a backing track.";
  if (message === "no-audio") return "No sound came with it. Share a browser tab and keep “Also share tab audio” on.";
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Tab sharing was cancelled.";
  return `Couldn't share the tab: ${message}`;
}

function read(): Partial<{ level: number; inRecordings: boolean }> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function write(prefs: { level: number; inRecordings: boolean }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // not kept
  }
}

/** The web's words on the desktop's Computer audio panel: it's a tab here. */
export function addTabAudioNote() {
  const panel = document.querySelector(".computer-audio");
  if (!panel || panel.querySelector(".web-tab-hint")) return;
  const label = panel.querySelector(".computer-toggle span:last-child");
  if (label) label.textContent = "Tab audio";
  const toggle = panel.querySelector(".computer-toggle");
  toggle?.setAttribute("title", "Sing along to a browser tab (a YouTube or Spotify tab): its sound under your voice, to hear and record together");
  panel.querySelector(".computer-level")?.setAttribute("aria-label", "Tab audio level");
  const options = panel.querySelector(".computer-options-button");
  options?.setAttribute("aria-label", "Tab audio options");
  options?.setAttribute("title", "Tab audio options, and which browsers share a tab's sound");
  const hint = Object.assign(document.createElement("p"), { className: "web-tab-hint", textContent: TAB_AUDIO_NOTE });
  panel.querySelector(".computer-options")?.append(hint);
}
