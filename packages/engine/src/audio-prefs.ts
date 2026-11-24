// The audio settings both web apps share (Voice and DAW): the sample rate the browser runs
// at and the low latency switch. Browsers have no ASIO-style drivers: what a page can do is
// ask for the smallest output buffer, keep the browser's own voice processing off the mic,
// run at the interface's rate (no resampling), and, in the DAW, render less far ahead.
// Kept in localStorage per app (each app has its own origin anyway).

/** 0 is "the device's own rate" (the browser picks, usually the output's). */
export type RatePref = 0 | 44100 | 48000 | 96000;

export interface AudioPrefs {
  rate: RatePref;
  /** Smallest buffers. Off asks for the browser's usual interactive buffer (and, in the DAW, a longer lead). */
  lowLatency: boolean;
}

export const RATES: { value: RatePref; label: string }[] = [
  { value: 0, label: "Match the device" },
  { value: 44100, label: "44.1 kHz" },
  { value: 48000, label: "48 kHz" },
  { value: 96000, label: "96 kHz" },
];

const KEY = "micfx.audio.prefs";
export const DEFAULT_PREFS: AudioPrefs = { rate: 0, lowLatency: true };

export function readAudioPrefs(): AudioPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AudioPrefs>;
    const rate = RATES.some((r) => r.value === saved.rate) ? (saved.rate as RatePref) : DEFAULT_PREFS.rate;
    return { rate, lowLatency: typeof saved.lowLatency === "boolean" ? saved.lowLatency : DEFAULT_PREFS.lowLatency };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // a private window: not kept
  }
}

/**
 * The AudioContext's options. A latencyHint of 0 seconds asks for the smallest buffer the
 * system allows (browsers clamp it); "interactive" is their usual low setting.
 */
export function contextOptions(prefs: AudioPrefs): AudioContextOptions {
  return { latencyHint: prefs.lowLatency ? 0 : "interactive", ...(prefs.rate ? { sampleRate: prefs.rate } : {}) };
}

/** Opens an AudioContext with these prefs; a rate the browser refuses falls back to the device's. */
export function openContext(prefs: AudioPrefs): AudioContext {
  try {
    return new AudioContext(contextOptions(prefs));
  } catch (error) {
    if (!prefs.rate) throw error;
    console.warn(`MicFX: the browser can't run at ${prefs.rate} Hz, using the device's rate`, error);
    return new AudioContext(contextOptions({ ...prefs, rate: 0 }));
  }
}

/**
 * The mic's constraints: the browser's echo cancelling, noise suppression and auto gain off
 * (they fight the effects and add delay), and, with low latency, the smallest capture buffer
 * the browser offers (the `latency` constraint, where it's supported).
 */
export function micConstraints(prefs: AudioPrefs, deviceId: string | undefined, channels: number): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: channels },
    ...(prefs.lowLatency ? { latency: { ideal: 0 } } : {}),
    ...(prefs.rate ? { sampleRate: { ideal: prefs.rate } } : {}),
  } as MediaTrackConstraints;
}

/** What the browser reports for this context (ms): its processing buffer and the output's delay. */
export function browserLatencyMs(context: AudioContext): { base: number; output: number } {
  const base = (context.baseLatency || 128 / context.sampleRate) * 1000;
  return { base, output: (context.outputLatency || 0) * 1000 };
}

/** The mic track's reported capture delay (ms), where the browser tells it. */
export function inputLatencyMs(stream: MediaStream | undefined): number | undefined {
  const settings = stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
  return typeof settings?.latency === "number" && Number.isFinite(settings.latency) ? settings.latency * 1000 : undefined;
}
