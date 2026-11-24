// The page's side of the engine worker: calls, events, files and the audio output.
import type { ChooserRequest, FileEntry, FromWorker, Rings, ToWorker } from "./protocol";
import EngineWorker from "./engine-worker?worker";
import workletUrl from "./daw-worklet?worker&url";
import { micConstraints, openContext, readAudioPrefs, type AudioPrefs } from "@micfx/engine/audio-prefs";

const MAX_INPUTS = 16; // the engine's input ring (PluginProcessor::maxAppInputs)

// How far ahead of the worklet the engine renders (frames). It is the monitoring path's own
// delay on top of the browser's: 1024 frames is 21 ms at 48 kHz. With low latency the engine
// starts at 256 (5.3 ms) and only goes up, a block at a time, when the sound breaks up.
const SAFE_LEAD = 1024;
const LOW_LEAD = 256;
const LEAD_KEY = "micfx.daw.lead";

function learnedLead(rate: number): number {
  try {
    const value = (JSON.parse(localStorage.getItem(LEAD_KEY) ?? "{}") as Record<string, number>)[rate];
    return typeof value === "number" && value >= LOW_LEAD && value <= SAFE_LEAD ? value : LOW_LEAD;
  } catch {
    return LOW_LEAD;
  }
}

function keepLead(rate: number, frames: number | undefined) {
  try {
    const all = JSON.parse(localStorage.getItem(LEAD_KEY) ?? "{}") as Record<string, number>;
    if (frames === undefined) delete all[rate];
    else all[rate] = frames;
    localStorage.setItem(LEAD_KEY, JSON.stringify(all));
  } catch {
    // not kept
  }
}

export type EventHandler = (name: string, payload: unknown) => void;
export type ChooserHandler = (request: ChooserRequest) => Promise<string[]>;

export class DawEngine {
  private readonly worker = new EngineWorker();
  private nextId = 1;
  private readonly calls = new Map<number, (value: unknown) => void>();
  private readonly requests = new Map<number, (reply: Extract<FromWorker, { type: "reply" }>) => void>();
  private memory?: WebAssembly.Memory;
  private rings?: Rings;
  context?: AudioContext;
  private node?: AudioWorkletNode;
  private sources: MediaStreamAudioSourceNode[] = [];
  private splitters: ChannelSplitterNode[] = [];
  private merger?: ChannelMergerNode;
  private streams: MediaStream[] = [];
  private channelCount = 0;
  private lastDevices: string[] | undefined;
  /** The inputs' names, in the order tracks see them. */
  inputNames: string[] = [];
  persistent = false;
  home = "/home/web";
  load = 0;
  underruns = 0;
  /** The audio settings this engine runs with (sample rate, low latency). */
  prefs: AudioPrefs = readAudioPrefs();
  /** The engine's lead now (frames), and the measured delay inside the page (frames, averaged). */
  lead = SAFE_LEAD;
  measuredLead = 0;
  inputBacklog = 0;
  private underrunsSeen = 0;
  private underrunsBase = 0;
  private startedAt = 0;
  onEvent: EventHandler = () => {};
  onChooser: ChooserHandler = async () => [];
  onClipboard = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  async start(): Promise<void> {
    // The rate the browser's output runs at (or the one asked for); the engine renders at it.
    this.context = openContext(this.prefs);
    this.lead = this.prefs.lowLatency ? learnedLead(this.context.sampleRate) : SAFE_LEAD;
    const ready = new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data;
        if (message.type === "ready") {
          this.memory = message.memory;
          this.rings = message.rings;
          this.persistent = message.persistent;
          this.home = message.home;
          resolve();
        } else if (message.type === "failed") reject(new Error(message.message));
        else this.receive(message);
      };
    });
    this.post({ type: "init", sampleRate: this.context.sampleRate, opfs: "storage" in navigator && "getDirectory" in navigator.storage, base: document.baseURI });
    await Promise.all([ready, this.context.audioWorklet.addModule(workletUrl)]);
    this.node = new AudioWorkletNode(this.context, "micfx-daw", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.postMessage({ memory: this.memory, rings: this.rings });
    this.node.port.onmessage = (event: MessageEvent<{ underruns: number; lead?: number; backlog?: number }>) => this.onAudioReport(event.data);
    this.node.connect(this.context.destination);
    this.updateAudio();
  }

  /** Starts the sound (browsers only allow it after a click or key). */
  resume() {
    if (this.context?.state === "suspended") void this.context.resume().then(() => {
      this.startedAt = performance.now();
      this.underrunsSeen = this.underruns;
      this.updateAudio();
    });
  }

  /** Twice a second from the worklet. With low latency, underruns past the first seconds
   * (the engine warming up) raise the lead a block; the lead that held is kept for next time. */
  private onAudioReport(report: { underruns: number; lead?: number; backlog?: number }) {
    if (report.lead !== undefined) this.measuredLead = report.lead;
    if (report.backlog !== undefined) this.inputBacklog = report.backlog;
    const fresh = report.underruns - this.underrunsSeen;
    this.underruns = report.underruns;
    this.underrunsSeen = report.underruns;
    const warm = this.startedAt && performance.now() - this.startedAt > 3000;
    if (!warm) this.underrunsBase = report.underruns; // starting up (or switching) isn't a dropout
    if (this.prefs.lowLatency && warm && fresh > 0 && this.lead < SAFE_LEAD) {
      this.lead = Math.min(SAFE_LEAD, this.lead + 128);
      keepLead(this.context!.sampleRate, this.lead);
      this.updateAudio();
    }
  }

  /** Low latency on or off at once (the lead); a new sample rate needs a reload (the engine
   * is prepared at its rate). Returns whether the page must reload. */
  applyPrefs(prefs: AudioPrefs): boolean {
    const rateChanged = prefs.rate !== this.prefs.rate;
    this.prefs = prefs;
    const rate = this.context?.sampleRate ?? 48000;
    if (!prefs.lowLatency) this.lead = SAFE_LEAD;
    else {
      keepLead(rate, undefined); // a fresh try at the smallest lead
      this.lead = LOW_LEAD;
    }
    this.startedAt = performance.now();
    this.updateAudio();
    // The open inputs, again with (or without) the small capture buffer.
    if (this.sources.length) void this.connectInput(this.lastDevices ?? []);
    return rateChanged;
  }

  /** The delay inside the page and the browser (ms): the engine's lead, the mic waiting in
   * the input ring, the browser's buffer and the output's own delay. */
  latencyParts() {
    const c = this.context;
    if (!c) return undefined;
    const rate = c.sampleRate;
    return {
      rate,
      lead: ((this.measuredLead || this.lead) / rate) * 1000,
      backlog: (this.inputBacklog / rate) * 1000,
      base: (c.baseLatency || 128 / rate) * 1000,
      output: (c.outputLatency || 0) * 1000,
      underruns: this.underruns - this.underrunsBase,
    };
  }

  /** The microphone (or audio interface) into the engine, for recording. With several
   * devices (plan point 26) their channels follow each other: the first device's are inputs
   * 1, 2..., the next one's come after, up to 16. Tracks pick their input by these names. */
  async connectInput(deviceIds?: string[]): Promise<boolean> {
    if (!this.context || !this.node) return false;
    if (this.sources.length && !deviceIds) return true;
    this.lastDevices = deviceIds;
    const wanted = deviceIds?.length ? deviceIds : [undefined];
    const streams: { stream: MediaStream; label: string }[] = [];
    for (const deviceId of wanted) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(this.prefs, deviceId, 16),
        });
        streams.push({ stream, label: stream.getAudioTracks()[0]?.label || "Input" });
      } catch (error) {
        console.warn("MicFX DAW: couldn't open an input", deviceId, error);
      }
    }
    if (!streams.length) return false;

    this.disconnectInputs();
    const sources = streams.map(({ stream }) => this.context!.createMediaStreamSource(stream));
    const channels = sources.map((source, i) => Math.max(1, streams[i]!.stream.getAudioTracks()[0]?.getSettings().channelCount ?? source.channelCount));
    const total = Math.min(MAX_INPUTS, channels.reduce((a, b) => a + b, 0));
    const names: string[] = [];
    if (sources.length === 1) {
      sources[0]!.connect(this.node);
      for (let ch = 0; ch < total; ch++) names.push(total === 1 ? streams[0]!.label : `${streams[0]!.label} ${ch + 1}`);
      this.merger = undefined;
    } else {
      this.merger = this.context.createChannelMerger(total);
      let next = 0;
      sources.forEach((source, i) => {
        const count = Math.min(channels[i]!, total - next);
        if (count <= 0) return;
        source.channelCountMode = "explicit";
        source.channelCount = channels[i]!;
        const splitter = this.context!.createChannelSplitter(channels[i]!);
        source.connect(splitter);
        for (let ch = 0; ch < count; ch++) {
          splitter.connect(this.merger!, ch, next + ch);
          names.push(count === 1 ? streams[i]!.label : `${streams[i]!.label} ${ch + 1}`);
        }
        this.splitters.push(splitter);
        next += count;
      });
      this.merger.connect(this.node);
    }
    this.node.channelCountMode = "explicit";
    this.node.channelCount = total;
    this.sources = sources;
    this.streams = streams.map((s) => s.stream);
    this.channelCount = total;
    this.inputNames = names;
    this.post({ type: "inputNames", names });
    this.updateAudio();
    return true;
  }

  private disconnectInputs() {
    for (const node of [...this.sources, ...this.splitters, ...(this.merger ? [this.merger] : [])]) node.disconnect();
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.sources = [];
    this.splitters = [];
    this.streams = [];
    this.merger = undefined;
  }

  get inputChannels() {
    return this.sources.length ? this.channelCount : 0;
  }

  /** The output's latency (seconds): the engine's lead plus what the browser adds. */
  get outputLatency() {
    const c = this.context;
    return c ? this.lead / c.sampleRate + c.baseLatency + (c.outputLatency || 0) : 0;
  }

  private updateAudio() {
    const rate = this.context?.sampleRate ?? 48000;
    const roundTrip = Math.round(this.outputLatency * rate * 2);
    this.post({ type: "audio", targetFrames: this.lead, inputChannels: this.inputChannels, roundTripFrames: roundTrip, paused: false });
  }

  call(name: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.post({ type: "call", id, name, args });
    });
  }

  midi(status: number, data1: number, data2: number) {
    this.post({ type: "midi", status, data1, data2 });
  }

  private request(message: Record<string, unknown> & { type: string }, transfer: Transferable[] = []) {
    const reqId = this.nextId++;
    return new Promise<Extract<FromWorker, { type: "reply" }>>((resolve) => {
      this.requests.set(reqId, resolve);
      this.worker.postMessage({ ...message, reqId }, transfer);
    });
  }

  async writeFile(path: string, data: ArrayBuffer) {
    const reply = await this.request({ type: "writeFile", path, data }, [data]);
    if (!reply.ok) throw new Error(reply.error);
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const reply = await this.request({ type: "readFile", path });
    if (!reply.ok || !reply.data) throw new Error(reply.error ?? "Couldn't read " + path);
    return reply.data;
  }

  async list(path: string): Promise<FileEntry[]> {
    const reply = await this.request({ type: "list", path });
    return reply.ok ? reply.entries ?? [] : [];
  }

  async remove(path: string) {
    const reply = await this.request({ type: "remove", path });
    if (!reply.ok) throw new Error(reply.error);
  }

  async mkdir(path: string) {
    await this.request({ type: "mkdir", path });
  }

  private post(message: ToWorker) {
    this.worker.postMessage(message);
  }

  private receive(message: FromWorker) {
    switch (message.type) {
      case "complete": {
        const resolve = this.calls.get(message.id);
        this.calls.delete(message.id);
        resolve?.(JSON.parse(message.json));
        break;
      }
      case "event":
        this.onEvent(message.name, JSON.parse(message.json));
        break;
      case "chooser":
        this.onChooser(message.request).then(
          (paths) => this.post({ type: "chooserResult", id: message.id, paths }),
          () => this.post({ type: "chooserResult", id: message.id, paths: [] }));
        break;
      case "clipboard":
        this.onClipboard(message.text);
        break;
      case "load":
        this.load = message.value;
        break;
      case "reply": {
        const resolve = this.requests.get(message.reqId);
        this.requests.delete(message.reqId);
        resolve?.(message);
        break;
      }
    }
  }
}
