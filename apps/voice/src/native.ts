// The desktop's C++ native functions (src/PluginEditor.cpp, createOptions) for the web.
//
// Each function answers in the shape the desktop UI expects. The parameter state lives in
// a "shadow" engine on this thread (same rules as the playing one: presets, order) and is
// mirrored to the AudioWorklet's engine whenever it runs. Features the browser can't do
// yet answer with empty data, so their panels stay quiet rather than break.
import type { JuceBackend, NativeFunction, ParameterInfo } from "@micfx/bridge";
import type { LiveEngine } from "@micfx/engine";
import type { LiveAudio, LiveMeters, TransportState } from "./audio";
import { createAudioSettings, savedInput, savedOutput } from "./devices";
import { createLibrary } from "./library";
import { Tracks } from "./tracks";

const MANUAL = "https://github.com/angelcandas/local-mic-effects/blob/main/docs/manual/user-manual.md";
const PREF_PREFIX = "micfx.ui.";
const METER_IDLE_MS = 250;
const SESSION_KEY = "micfx.session";
const SESSION_SAVE_MS = 400;
const RECORD_DRY_PREF = "micfx.record.dry";

const toDb = (peak: number) => (peak > 0 ? Math.max(-100, 20 * Math.log10(peak)) : -100);

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function createNative({ shadow, audio, parameters }: { shadow: LiveEngine; audio: LiveAudio; parameters: Record<string, ParameterInfo> }) {
  let backend: JuceBackend | undefined;
  const presets = shadow.factoryPresets();
  const ids = Object.keys(parameters);
  let currentPreset = -1;
  let muted = false;
  let dry = false;
  let lastOrder = shadow.getOrder().join(",");
  let lastMeters: LiveMeters = { input: 0, output: 0, latencySamples: 0 };
  let status: Record<string, unknown> = {};
  let starting: Promise<unknown> | undefined;

  // The sing-along tracks and the recorder. The transport is the worklet's; until the audio
  // runs (or a stale meter after a command), the page's own copy answers.
  const tracks = new Tracks(audio);
  tracks.onChanged = () => backend?.emit("tracks", null);
  tracks.onError = (message) => backend?.emit("trackError", message);
  let transport: TransportState = { position: 0, length: 0, playing: false };
  let recording = false;
  let stopping: Promise<unknown> | undefined;
  let lastTakeResult: unknown = null;

  // The last session (values, order, preset) comes back, as the desktop app's state does.
  const restore = () => {
    try {
      const saved = JSON.parse(storage()?.getItem(SESSION_KEY) ?? "null") as { values?: Record<string, number>; order?: string[]; preset?: number } | null;
      if (!saved) return;
      for (const [id, value] of Object.entries(saved.values ?? {})) if (id in parameters) shadow.setValue(id, Number(value));
      if (Array.isArray(saved.order)) shadow.setOrder(saved.order.map(String));
      currentPreset = typeof saved.preset === "number" ? saved.preset : -1;
      lastOrder = shadow.getOrder().join(",");
    } catch {
      // A broken entry: start from the defaults.
    }
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        storage()?.setItem(SESSION_KEY, JSON.stringify({ values: allValues(), order: shadow.getOrder(), preset: currentPreset }));
      } catch {
        // Storage full or blocked: the session just isn't kept.
      }
    }, SESSION_SAVE_MS);
  };

  /** Every parameter, as the shadow engine has them. */
  const allValues = () => Object.fromEntries(ids.map((id) => [id, shadow.getValue(id) ?? parameters[id]!.default]));

  /** Shows the shadow's values on the page's controls, and tells the page the order. */
  const syncPage = () => {
    for (const id of ids) backend?.setParameter(id, shadow.getValue(id) ?? parameters[id]!.default);
    emitOrderIfChanged();
  };

  const emitOrderIfChanged = () => {
    const order = shadow.getOrder().join(",");
    if (order === lastOrder) return;
    lastOrder = order;
    backend?.emit("chainOrder", order);
  };

  /** The page's state to the playing engine (on start). */
  const pushToAudio = () => {
    audio.preset(allValues(), shadow.getOrder());
    audio.set({ outputMuted: muted ? 1 : 0, dryCompare: dry ? 1 : 0 });
  };

  /** Starts the mic (needs a click: browsers only start sound from one). */
  const startAudio = () => {
    if (audio.running) return Promise.resolve();
    starting ??= audio
      .setOutput(savedOutput())
      .then(() => audio.start(savedInput() || undefined))
      .catch((error) => {
        // The saved mic is gone (unplugged): the default one.
        if (savedInput() && error instanceof DOMException && /Overconstrained|NotFound/.test(error.name)) return audio.start();
        throw error;
      })
      .then(async () => {
        pushToAudio();
        audio.wantStatus(true);
        transport = { ...transport, playing: false };
        await tracks.pushAll();
        audio.transport("seek", transport.position);
      })
      .catch((error) => {
        console.error("MicFX: couldn't start the audio", error);
        backend?.emit("trackError", micErrorText(error));
      })
      .finally(() => (starting = undefined));
    return starting;
  };

  // The setup strip asks for the audio state every second, so changes show without a nudge.
  const library = createLibrary({
    shadow,
    values: allValues,
    apply: (values, order) => {
      shadow.resetValues();
      for (const [id, value] of Object.entries(values)) if (id in parameters && id !== "inputGain") shadow.setValue(id, value);
      shadow.setOrder(order);
      currentPreset = -1;
      pushToAudio();
      syncPage();
      saveSoon();
    },
  });

  const settings = createAudioSettings(audio, () => startAudio(), () => {});

  audio.onMeters = (meters) => {
    lastMeters = meters;
    if (meters.transport) transport = meters.transport;
    if ("status" in meters && meters.status) status = meters.status as unknown as Record<string, unknown>;
  };

  const describeAudio = () => {
    const rate = audio.sampleRate;
    const running = audio.running;
    const total = audio.latencyMs() ?? 0;
    const effectsMs = rate ? (lastMeters.latencySamples / rate) * 1000 : 0;
    return {
      available: true,
      device: running ? audio.deviceLabel || "Microphone" : "Sound off · click to start",
      rate: rate ?? 48000,
      buffer: 128,
      latencyMs: Math.max(0, total - effectsMs),
      effectsMs,
      cpu: 0,
      xruns: 0,
      // Until the mic is started (a click), the input counts as muted, as the desktop's is
      // until you say you wear headphones.
      inputMuted: !running,
      inputs: [],
      liveInput: 0,
    };
  };

  const meters = () => ({
    input: toDb(lastMeters.input),
    output: toDb(lastMeters.output),
    note: (status.note as number) ?? -1,
    target: (status.target as number) ?? -1,
    chord: "",
    voices: (status.voices as number[]) ?? [],
    preset: currentPreset,
    fx: (status.fx as Record<string, unknown>) ?? {},
    midi: { count: 0, last: "", learning: "" },
    muted,
    // While a take starts, the worklet may not have said so yet: 0 until it does.
    recording: recording && audio.running ? Math.max(0, lastMeters.recording ?? 0) : -1,
    capture: -1,
    transport: { ...transport, length: Math.max(transport.length, tracks.length), loading: tracks.loading },
  });

  const functions: Record<string, NativeFunction> = {
    logError: (message: string) => console.error(`[desktop UI] ${message}`),

    getParameterDefaults: () => Object.fromEntries(ids.map((id) => [id, parameters[id]!.default])),
    getParameterInfo: () => parameters,

    getPresets: () => presets.map(({ name, category }) => ({ name, category })),
    loadPreset: (index: number) => {
      if (!shadow.loadPreset(Number(index))) return currentPreset;
      currentPreset = Number(index);
      audio.loadPreset(currentPreset);
      syncPage();
      saveSoon();
      return currentPreset;
    },

    chainOrder: (action = "get", key?: unknown, to?: unknown) => {
      let keys = shadow.getOrder();
      if (action === "set" && Array.isArray(key)) keys = key.map(String);
      else if ((action === "move" || action === "last") && typeof key === "string") {
        const from = keys.indexOf(key);
        if (from >= 0) {
          keys.splice(from, 1);
          const at = action === "last" || to === undefined ? keys.length : Math.max(0, Math.min(keys.length, Number(to)));
          keys.splice(at, 0, key);
        }
      }
      if (action !== "get") {
        shadow.setOrder(keys);
        audio.setOrder(shadow.getOrder());
        lastOrder = shadow.getOrder().join(","); // the page asked for it: no event back
        saveSoon();
      }
      return shadow.getOrder();
    },

    uiPref: (key: string, value?: unknown) => {
      const name = PREF_PREFIX + String(key).replace(/[^A-Za-z0-9._-]/g, "");
      const store = storage();
      if (value !== undefined) store?.setItem(name, String(value).slice(0, 20000));
      return store?.getItem(name) ?? "";
    },

    liveControl: (action: string, on?: boolean) => {
      if (action === "mute") muted = Boolean(on);
      if (action === "dry") dry = Boolean(on);
      audio.set({ outputMuted: muted ? 1 : 0, dryCompare: dry ? 1 : 0 });
      return { muted, dry };
    },

    window: async (action?: string) => {
      if (action === "fullScreen") {
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        else await document.documentElement.requestFullscreen().catch(() => {});
      }
      return { available: Boolean(document.fullscreenEnabled), fullScreen: Boolean(document.fullscreenElement) };
    },

    help: (topic = "manual") => {
      window.open(MANUAL + (topic === "manual" ? "" : `#${encodeURIComponent(String(topic))}`), "_blank", "noopener");
      return true;
    },

    audioSetup: async (action?: string) => {
      // "headphones" (the first-run card's "I'm wearing headphones") and "settings" (the
      // status strip) are clicks, so they may start the mic.
      if (action === "headphones" || action === "settings") await startAudio();
      if (action === "settings") void settings.open();
      return describeAudio();
    },

    echoTapTempo: () => null,

    // The sing-along tracks and the recorder (the desktop's Multitrack and Recorder).
    getTracks: () => tracks.rows(),
    loadBackingTrack: () => tracks.pickBackingTrack(),
    setTrack: (id: number, options: { gain?: number; muted?: boolean } = {}) => tracks.set(Number(id), options ?? {}),
    removeTrack: (id: number) => tracks.remove(Number(id)),
    detectBackingKey: () => tracks.detectBackingKey(),

    transport: async (action: string, seconds?: number) => {
      if (!["play", "pause", "stop", "seek"].includes(action)) return null;
      if (action === "play") await startAudio(); // a click: it may start the sound
      const at = action === "stop" ? 0 : action === "seek" ? Math.max(0, Number(seconds) || 0) : transport.position;
      transport = { ...transport, position: at, playing: action === "play" ? audio.running : action === "pause" || action === "stop" ? false : transport.playing };
      audio.transport(action as "play" | "pause" | "stop" | "seek", at);
      return null;
    },

    getRecorderSettings: () => ({ folder: "this browser", includeDry: readDry(), recording }),
    chooseRecordingFolder: () => ({ folder: "this browser", includeDry: readDry(), recording }),
    setRecordDry: (on: boolean) => {
      try {
        storage()?.setItem(RECORD_DRY_PREF, on ? "1" : "0");
      } catch {
        // not kept
      }
      return null;
    },

    startRecording: async (includeDry?: boolean) => {
      await stopping;
      await startAudio();
      if (!audio.running) return { ok: false, error: "Start the sound first: MicFX needs your microphone to record." };
      audio.startRecording(Boolean(includeDry));
      recording = true;
      transport = { ...transport, playing: true };
      return { ok: true, error: "" };
    },

    stopRecording: () => {
      if (!recording) return lastTakeResult;
      recording = false;
      transport = { ...transport, playing: false };
      const latency = (audio.latencyMs() ?? 0) / 1000;
      const stop = (async () => {
        const take = await audio.stopRecording();
        if (!take) return (lastTakeResult = null);
        // What you sang lines up with what you heard: back by the round trip, as the desktop does.
        const track = await tracks.addTake(take, take.start - latency);
        lastTakeResult = { file: track.fileName, fileName: track.fileName, dryFile: track.dryFileName ?? "", seconds: take.seconds, dropped: false };
        return lastTakeResult;
      })();
      stopping = stop.catch(() => {});
      return stop;
    },

    // "Show" on the saved take: the browser downloads it.
    revealRecording: () => tracks.downloadLastTake(),

    // Not on the web yet. null is what the desktop's functions answer when their part
    // isn't there (no DAW session, no song): the panels then stay empty.
    soundCheck: () => ({ phase: "idle", styles: [], style: 0 }),
    daw: () => null,
    practice: () => null,
    looper: () => null,
    liveHistory: () => null,
    liveMacros: () => null,
    scenes: () => null,
    setlist: () => null,
    library,
    midi: () => null,
    capture: () => null,
    computerAudio: () => null,
    liveInstruments: () => null,
    moduleFile: () => null,
    singAlongToDaw: () => null,
  };

  restore();
  void tracks.restore();

  return {
    functions,
    attach(b: JuceBackend) {
      backend = b;
      for (const id of ids) b.setParameter(id, shadow.getValue(id) ?? parameters[id]!.default);
    },
    /** A control on the page moved. */
    parameterChanged(id: string, value: number) {
      shadow.setValue(id, value);
      audio.set({ [id]: value });
      saveSoon();
    },
    /** The desktop UI has loaded: the meters event starts. */
    started() {
      const tick = () => {
        backend?.emit("meters", meters());
        setTimeout(tick, audio.running ? 33 : METER_IDLE_MS);
      };
      tick();
    },
  };
}

function readDry(): boolean {
  try {
    return storage()?.getItem(RECORD_DRY_PREF) === "1";
  } catch {
    return false;
  }
}

function micErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "MicFX needs your microphone. Allow it in the browser's address bar, then try again.";
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone found. Plug one in and try again.";
  return `Couldn't start the audio: ${error instanceof Error ? error.message : String(error)}`;
}
