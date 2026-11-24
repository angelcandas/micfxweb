// The page's side of the engine worker: calls, events, files and the audio output.
import type { ChooserRequest, FileEntry, FromWorker, Rings, ToWorker } from "./protocol";
import EngineWorker from "./engine-worker?worker";
import workletUrl from "./daw-worklet?worker&url";

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
  private mic?: MediaStreamAudioSourceNode;
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

  /** The microphone (or audio interface) into the engine, for recording. */
  async connectInput(deviceId?: string): Promise<boolean> {
    if (!this.context || !this.node) return false;
    if (this.mic && !deviceId) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      });
      this.mic?.disconnect();
      this.mic = this.context.createMediaStreamSource(stream);
      this.mic.connect(this.node);
      this.updateAudio();
      return true;
    } catch (error) {
      console.warn("MicFX DAW: no microphone", error);
      return false;
    }
  }

  get inputChannels() {
    return this.mic ? Math.max(1, this.mic.channelCount) : 0;
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
