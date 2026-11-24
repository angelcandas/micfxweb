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
import { Tracks, decodeChannels, encodeWav, download, songFiles } from "./tracks";
import { splitVoice } from "./stems-client";
import { Setlist } from "./setlist";
import { SoundCheck } from "./sound-check";
import { findMelody, pageAnalysis, songSections, soundCheckPlan, warpAudio } from "./analysis-client";
import { Practice, opfsStore } from "./practice";
import type { LooperState } from "@micfx/engine";
import { LiveHistory, Scenes, type ParameterAccess, type SavedScenes } from "./live-state";
import { MidiMap, connectMidi, midiAlreadyAllowed, type Mapping } from "./midi-map";

const MANUAL = "https://github.com/angelcandas/local-mic-effects/blob/main/docs/manual/user-manual.md";
const PREF_PREFIX = "micfx.ui.";
const METER_IDLE_MS = 250;
const SESSION_KEY = "micfx.session";
const SESSION_SAVE_MS = 400;
const RECORD_DRY_PREF = "micfx.record.dry";
const MIDI_KEY = "micfx.midi";
const LOOPER_KEY = "micfx.looper";
const SETLIST_KEY = "micfx.setlist";
const PRACTICE_KEY = "micfx.practice";

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

  // The looper plays in the worklet's engine. Its tempo, lock and volume are app
  // preferences, like on the desktop; the shadow engine answers while the sound is off.
  const looperPrefs = (() => {
    try {
      return JSON.parse(storage()?.getItem(LOOPER_KEY) ?? "{}") as { bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number };
    } catch {
      return {};
    }
  })();
  shadow.looperSettings(looperPrefs);
  let looperState: LooperState = shadow.looperState();
  const saveLooperPrefs = () => {
    const { bpm, beatsPerBar, locked, volume } = looperState;
    try {
      storage()?.setItem(LOOPER_KEY, JSON.stringify({ bpm, beatsPerBar, locked, volume }));
    } catch {
      // not kept
    }
  };

  const setLooper = (settings: { bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number }) => {
    for (const [key, value] of Object.entries(settings)) if (value !== undefined) (looperPrefs as Record<string, unknown>)[key] = value;
    shadow.looperSettings(settings);
    audio.looperSettings(settings);
    looperState = { ...looperState, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) };
    saveLooperPrefs();
  };

  // The last session (values, order, preset) comes back, as the desktop app's state does.
  const restore = () => {
    try {
      const saved = JSON.parse(storage()?.getItem(SESSION_KEY) ?? "null") as { values?: Record<string, number>; order?: string[]; preset?: number; scenes?: SavedScenes } | null;
      if (!saved) return;
      scenes.restore(saved.scenes);
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
        storage()?.setItem(SESSION_KEY, JSON.stringify({ values: allValues(), order: shadow.getOrder(), preset: currentPreset, scenes: scenes.save() }));
      } catch {
        // Storage full or blocked: the session just isn't kept.
      }
    }, SESSION_SAVE_MS);
  };

  // Undo/redo and scenes work on the parameters the way the page's own controls do.
  const access: ParameterAccess = {
    ids,
    info: parameters,
    get: (id) => shadow.getValue(id) ?? parameters[id]!.default,
    set: (id, value) => {
      shadow.setValue(id, value);
      audio.set({ [id]: value });
      backend?.setParameter(id, shadow.getValue(id) ?? value);
      saveSoon();
    },
  };
  const history = new LiveHistory(access);
  const describeHistory = () => ({ undo: history.undoName, redo: history.redoName, preset: currentPreset });
  history.getPreset = () => currentPreset;
  history.setPreset = (index) => {
    currentPreset = index;
    saveSoon();
  };
  history.onChange = () => backend?.emit("liveHistory", describeHistory());
  const scenes = new Scenes(access);
  scenes.onChange = () => saveSoon();

  // MIDI learn over Web MIDI. The mappings belong to the app, not the sound (as on the desktop).
  const midiMap = new MidiMap(access);
  const describeMidi = () => ({ mappings: midiMap.describe(), learning: midiMap.learning, last: midiMap.lastEvent });
  try {
    midiMap.setMappings(JSON.parse(storage()?.getItem(MIDI_KEY) ?? "[]") as Mapping[], false);
  } catch {
    // a broken entry: no mappings
  }
  midiMap.onMappingsChanged = (list) => {
    try {
      storage()?.setItem(MIDI_KEY, JSON.stringify(list));
    } catch {
      // not kept
    }
  };
  midiMap.onLearned = (mapping) =>
    backend?.emit("midiLearned", { target: mapping.target, name: midiMap.describe().find((m) => m.target === mapping.target)?.name ?? "", midi: describeMidi() });
  midiMap.onPresetStep = (delta) => {
    const count = presets.length;
    if (count) functions.loadPreset!((((currentPreset + delta) % count) + count) % count);
  };
  midiMap.onMuteToggle = () => {
    muted = !muted;
    audio.set({ outputMuted: muted ? 1 : 0 });
  };
  midiMap.onScene = (action) => {
    if (action === "scene.next") scenes.handle("step", { delta: 1 });
    else if (action === "scene.previous") scenes.handle("step", { delta: -1 });
    else scenes.handle("recall", { index: Number(action.slice("scene.".length)) - 1 });
  };
  midiMap.onAction = (action) => {
    const command = action.startsWith("looper.") ? action.slice("looper.".length) : "";
    if (["main", "stop", "play", "undo", "redo", "clear"].includes(command)) audio.looper(command as "main");
    else backend?.emit("midiAction", action);
  };
  let midiConnected: Promise<boolean> | undefined;
  const connectMidiOnce = () => (midiConnected ??= connectMidi((data) => midiMap.receive(data)).then((ok) => {
    if (!ok) midiConnected = undefined; // ask again next time
    return ok;
  }));
  // Allowed on an earlier visit: listen from the start, so mapped pedals just work.
  if (midiMap.getMappings().length) void midiAlreadyAllowed().then((yes) => yes && connectMidiOnce());

  // The setlist: kept in this browser, saved and opened as .micfxset files.
  const setlist = new Setlist({
    params: access,
    getOrder: () => shadow.getOrder().join(","),
    setOrder: (order) => {
      shadow.setOrder(order ? order.split(",") : []);
      audio.setOrder(shadow.getOrder());
      emitOrderIfChanged();
      saveSoon();
    },
    scenes,
    looper: () => looperState,
    looperStop: () => audio.looper("stop"),
    looperTempo: (bpm) => setLooper({ bpm, locked: true }),
    currentBacking: () => tracks.currentBacking(),
    replaceBacking: async (file) => {
      transport = { ...transport, position: 0, playing: false };
      audio.transport("stop", 0);
      await tracks.replaceBacking(file);
    },
    files: songFiles(),
    persist: (saved) => {
      try {
        storage()?.setItem(SETLIST_KEY, JSON.stringify(saved));
      } catch {
        backend?.emit("trackError", "This browser has no room left to keep the setlist: save it as a file.");
      }
    },
    label: (name) => history.label(name),
  });
  try {
    setlist.restore(JSON.parse(storage()?.getItem(SETLIST_KEY) ?? "null"));
  } catch {
    // a broken entry: an empty setlist
  }
  const describeSetlist = (warning = "", error = "") => ({ ...setlist.describe(), available: true, recent: [], warning, error });

  const handleSetlist = async (action: string, options: Record<string, unknown>) => {
    const index = typeof options.index === "number" ? options.index : -1;
    if (action === "add") await setlist.add(String(options.name ?? ""));
    if (action === "update") await setlist.update(index);
    if (action === "remove") setlist.remove(index);
    if (action === "move") setlist.move(index, typeof options.to === "number" ? options.to : index);
    if (action === "info") setlist.setInfo(index, options);
    if (action === "new") setlist.clear();
    if (action === "load" || action === "step") {
      // A song change replaces the backing track, so it waits while a take is recording.
      if (recording) return describeSetlist("", "Stop recording before changing songs.");
      const { warning } = action === "load" ? await setlist.load(index) : await setlist.step(typeof options.delta === "number" ? options.delta : 1);
      syncPage();
      return describeSetlist(warning);
    }
    if (action === "save" || action === "saveAs") {
      download(new Blob([setlist.toFile()], { type: "application/xml" }), `${setlist.name}.micfxset`);
    }
    if (action === "open") {
      const file = await pickFile(".micfxset,application/xml,text/xml");
      if (file) {
        const error = setlist.open(await file.text(), file.name);
        if (error) return describeSetlist("", error);
      }
    }
    if (action === "chooseBacking" && setlist.song(index)) {
      const file = await pickFile("audio/*,.wav,.aif,.aiff,.flac,.ogg,.mp3,.m4a");
      if (file) await setlist.setBacking(index, file);
    }
    if (action === "chooseLyrics" && setlist.song(index)) {
      const file = await pickFile(".txt,.lrc,text/plain");
      if (file && file.size > 200000) return describeSetlist("", "That file is too big for lyrics.");
      if (file) setlist.setInfo(index, { lyrics: await file.text() });
    }
    return describeSetlist();
  };

  // Sound check: the mic from the worklet, the desktop's planner in a worker.
  const soundCheck = new SoundCheck({
    params: access,
    listen: async (on) => {
      if (on) await startAudio(); // a click: it may start the sound
      if (on && !audio.running) return false;
      audio.captureMic(on);
      return true;
    },
    plan: soundCheckPlan,
    offerNoiseProfile: (bins) => audio.offerNoiseProfile(bins),
    addScene: (name) => {
      const index = scenes.add(name);
      if (index >= 0) saveSoon();
      return index;
    },
    sceneName: (index) => scenes.describe().scenes[index]?.name ?? "",
    onChange: (state) => backend?.emit("soundCheck", state),
  });
  // Practice: songs kept in this browser's private files, scored against the pitch tap.
  let practiceOn = false;
  const practice = new Practice({
    store: opfsStore(),
    scorer: pageAnalysis,
    decode: decodeChannels,
    split: splitVoice,
    encodeWav,
    findMelody,
    pickFile,
    download,
    install: async (guide, backing, level) => {
      transport = { ...transport, position: 0, playing: false };
      audio.transport("stop", 0);
      await tracks.replaceBacking(undefined);
      if (backing) await tracks.addBackingTrack(backing);
      return tracks.addBackingTrack(guide, { gain: level, muted: level <= 0 });
    },
    setGuide: (id, level) => tracks.set(id, { gain: level, muted: level <= 0 }),
    trackIds: () => tracks.rows().map((row) => row.id),
    restart: () => {
      transport = { ...transport, position: 0, playing: false };
      audio.transport("stop", 0);
    },
    seek: (seconds, play) => {
      transport = { ...transport, position: seconds, playing: play && audio.running };
      audio.transport("seek", seconds);
      if (play) audio.transport("play");
    },
    loop: (from, to) => audio.loop(from, to),
    sections: songSections,
    warp: warpAudio,
    pitch: (on) => {
      practiceOn = on;
      audio.pitch(on);
    },
    latency: () => describeAudio().latencyMs / 1000,
    emit: (name, payload) => backend?.emit(name, payload),
    load: () => storage()?.getItem(PRACTICE_KEY) ?? null,
    save: (value) => {
      try {
        storage()?.setItem(PRACTICE_KEY, value);
      } catch {
        // not kept
      }
    },
  });

  audio.onMicChunk = (samples) => {
    // As the desktop captures it: after the input gain.
    const gain = Math.pow(10, access.get("inputGain") / 20);
    if (gain !== 1) for (let i = 0; i < samples.length; ++i) samples[i]! *= gain;
    soundCheck.capture(samples);
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
        soundCheck.prepare(audio.sampleRate ?? 48000);
        pushToAudio();
        audio.wantStatus(true);
        audio.looperSettings(looperPrefs);
        audio.pitch(practiceOn);
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
    if (meters.looper) looperState = { ...meters.looper, overviews: meters.looper.overviews ?? looperState.overviews };
    if ("status" in meters && meters.status) status = meters.status as unknown as Record<string, unknown>;
    if (meters.transport) practice.tick(meters.pitch, meters.transport, audio.sampleRate ?? 48000);
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
    midi: { count: midiMap.eventCount, last: midiMap.lastEvent, learning: midiMap.learning },
    muted,
    // While a take starts, the worklet may not have said so yet: 0 until it does.
    recording: recording && audio.running ? Math.max(0, lastMeters.recording ?? 0) : -1,
    capture: -1,
    transport: { ...transport, length: Math.max(transport.length, tracks.length), loading: tracks.loading },
    scenes: scenes.describe(),
    looper: looperState,
  });

  const functions: Record<string, NativeFunction> = {
    logError: (message: string) => console.error(`[desktop UI] ${message}`),

    getParameterDefaults: () => Object.fromEntries(ids.map((id) => [id, parameters[id]!.default])),
    getParameterInfo: () => parameters,

    getPresets: () => presets.map(({ name, category }) => ({ name, category })),
    loadPreset: (index: number) => {
      const preset = presets[Number(index)];
      if (!preset) return currentPreset;
      history.label(`Load preset ${preset.name}`);
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
    soundCheck: (action = "state", options?: Record<string, unknown>) => soundCheck.handle(String(action), options ?? {}),
    daw: () => null,
    practice: (action = "state", options?: Record<string, unknown>) => practice.handle(String(action), options ?? {}),
    looper: async (action = "status", options: Record<string, unknown> = {}) => {
      const commands = ["main", "stop", "play", "undo", "redo", "clear"] as const;
      const command = commands.find((c) => c === action);
      if (command) {
        if (command === "main") await startAudio(); // a click: it may start the sound
        audio.looper(command);
      }
      if (action === "layer" && typeof options.layer === "number") {
        const layer = { gain: typeof options.gain === "number" ? options.gain : undefined, muted: typeof options.muted === "boolean" ? options.muted : undefined };
        audio.looperLayer(options.layer, layer);
        if (layer.gain !== undefined) looperState.gains[options.layer] = layer.gain;
        if (layer.muted !== undefined) looperState.mutes[options.layer] = layer.muted;
      }
      if (action === "settings")
        setLooper({
          bpm: typeof options.bpm === "number" ? options.bpm : undefined,
          beatsPerBar: typeof options.beatsPerBar === "number" ? options.beatsPerBar : undefined,
          locked: typeof options.locked === "boolean" ? options.locked : undefined,
          volume: typeof options.volume === "number" ? Math.min(2, Math.max(0, options.volume)) : undefined,
        });
      if (action === "save") {
        const { layers, sampleRate } = await audio.looperLayers();
        if (!layers.length) return { ok: false, error: "Record a loop first.", files: [], folder: "" };
        const base = `Loop ${new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "-")}`;
        const files = layers.map((layer, i) => {
          const name = `${base} - layer ${i + 1}.wav`;
          download(encodeWav(layer, sampleRate), name);
          return name;
        });
        return { ok: true, error: "", files, folder: "your downloads" };
      }
      if (action === "sendToDaw") return { ok: false, error: "Sending loops to the DAW comes with MicFX DAW.", files: [], folder: "" };
      return looperState;
    },
    liveHistory: (action?: string, name?: string) => {
      if (action === "undo") history.undo();
      if (action === "redo") history.redo();
      if (action === "label") history.label(String(name ?? ""));
      if (action === "hold") history.hold(String(name ?? ""));
      if (action === "release") history.release();
      return describeHistory();
    },
    liveMacros: () => null,
    scenes: (action = "list", options?: Record<string, unknown>) => scenes.handle(String(action), options ?? {}),
    setlist: (action = "list", options?: Record<string, unknown>) => handleSetlist(String(action), options ?? {}),
    library,
    midi: async (action = "list", options?: { target?: string }) => {
      const target = String(options?.target ?? "");
      if (action === "learn" && target) {
        // Picking a control is a click: the browser may ask to allow MIDI devices.
        const ok = await connectMidiOnce();
        if (!ok) {
          backend?.emit("trackError", "This browser can't use MIDI devices, or MIDI was blocked. Chrome and Edge have Web MIDI.");
          return describeMidi();
        }
        midiMap.learning = target;
      }
      if (action === "cancel") midiMap.learning = "";
      if (action === "remove") midiMap.removeTarget(target);
      if (action === "clear") midiMap.setMappings([]);
      return describeMidi();
    },
    capture: () => null,
    computerAudio: () => null,
    liveInstruments: () => null,
    moduleFile: () => null,
    singAlongToDaw: () => null,
  };

  restore();
  void tracks.restore().then(() => practice.restore());

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
      history.start();
      const tick = () => {
        backend?.emit("meters", meters());
        setTimeout(tick, audio.running ? 33 : METER_IDLE_MS);
      };
      tick();
    },
  };
}

/** Asks for a file (a click); undefined when none was picked. */
function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept });
    input.addEventListener("change", () => resolve(input.files?.[0]));
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
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
