// The page's side of the engine worker: calls, events, files and the audio output.
import type { ChooserRequest, FileEntry, FromWorker, Rings, ToWorker } from "./protocol";
import EngineWorker from "./engine-worker?worker";
import workletUrl from "./daw-worklet?worker&url";

const MAX_INPUTS = 16; // the engine's input ring (PluginProcessor::maxAppInputs)

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
  /** The inputs' names, in the order tracks see them. */
  inputNames: string[] = [];
  persistent = false;
  home = "/home/web";
  load = 0;
  underruns = 0;
  onEvent: EventHandler = () => {};
  onChooser: ChooserHandler = async () => [];
  onClipboard = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  async start(): Promise<void> {
    // The rate the browser's output runs at; the engine renders at it.
    this.context = new AudioContext({ latencyHint: "interactive" });
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
    this.node.port.onmessage = (event: MessageEvent<{ underruns: number }>) => (this.underruns = event.data.underruns);
    this.node.connect(this.context.destination);
    this.updateAudio();
  }

  /** Starts the sound (browsers only allow it after a click or key). */
  resume() {
    if (this.context?.state === "suspended") void this.context.resume().then(() => this.updateAudio());
  }

  /** The microphone (or audio interface) into the engine, for recording. With several
   * devices (plan point 26) their channels follow each other: the first device's are inputs
   * 1, 2..., the next one's come after, up to 16. Tracks pick their input by these names. */
  async connectInput(deviceIds?: string[]): Promise<boolean> {
    if (!this.context || !this.node) return false;
    if (this.sources.length && !deviceIds) return true;
    const wanted = deviceIds?.length ? deviceIds : [undefined];
    const streams: { stream: MediaStream; label: string }[] = [];
    for (const deviceId of wanted) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 16 } },
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
    return c ? 1024 / c.sampleRate + c.baseLatency + (c.outputLatency || 0) : 0;
  }

  private updateAudio() {
    const rate = this.context?.sampleRate ?? 48000;
    const roundTrip = Math.round(this.outputLatency * rate * 2);
    this.post({ type: "audio", targetFrames: 1024, inputChannels: this.inputChannels, roundTripFrames: roundTrip, paused: false });
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
