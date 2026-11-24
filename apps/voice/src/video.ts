// Video with your voice (plan section 9, point 8): the camera and what you hear (the voice
// with its effects, the backing track, a shared tab) recorded together as a video file for
// social posts, with a live preview and a look at the result before it's saved.
//
// The camera is drawn on a canvas in the shape picked (wide, tall for stories, square),
// cropped from the middle, and that canvas's picture is what's recorded. MP4 where the
// browser records it (Chrome, Edge, Safari), WebM elsewhere (Firefox).
import { download, timestamp } from "./tracks";

export interface VideoHooks {
  startAudio(): Promise<unknown>;
  outputStream(): MediaStream | undefined;
}

const SHAPES = {
  wide: { label: "Wide 16:9", width: 1280, height: 720 },
  tall: { label: "Tall 9:16 (stories, reels)", width: 720, height: 1280 },
  square: { label: "Square 1:1", width: 1080, height: 1080 },
} as const;
type Shape = keyof typeof SHAPES;

const TYPES = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** The first video type this browser records, and its file extension. */
export function videoType(): { mime: string; extension: string } | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const mime = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  return mime ? { mime, extension: mime.startsWith("video/mp4") ? "mp4" : "webm" } : undefined;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The "Video" button beside the recorder, and its window. */
export function addVideo(hooks: VideoHooks) {
  const anchor = document.querySelector("footer.recorder .web-metronome") ?? document.querySelector("footer.recorder .record-dry");
  if (!anchor || document.querySelector(".web-video-button")) return;
  const button = html("button", "pill web-video-button", "Video");
  button.type = "button";
  button.title = "Record a video: the camera with your voice as you hear it";
  anchor.after(button);
  button.addEventListener("click", () => void new VideoWindow(hooks).open());
}

class VideoWindow {
  private dialog = html("dialog", "web-video");
  private preview = html("video", "web-video-preview");
  private result = html("video", "web-video-result");
  private canvas = html("canvas", "web-video-canvas");
  private status = html("p", "web-video-status");
  private shape = html("select", "dropdown web-video-shape");
  private camera = html("select", "dropdown web-video-camera");
  private record = html("button", "tool is-accent web-video-record", "Record");
  private save = html("button", "tool is-accent web-video-save", "Save video");
  private again = html("button", "tool web-video-again", "Record again");
  private close = html("button", "tool web-video-close", "Close");
  private cameraStream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private drawing = 0;
  private started = 0;
  private timer = 0;
  private file: Blob | undefined;
  private type = videoType();

  constructor(private readonly hooks: VideoHooks) {
    const dialog = this.dialog;
    dialog.setAttribute("aria-label", "Record a video");
    const head = html("div", "web-video-head");
    head.append(html("strong", "", "Video with your voice"), this.close);

    for (const [value, { label }] of Object.entries(SHAPES)) this.shape.append(new Option(label, value));
    this.shape.value = readShape();
    this.shape.setAttribute("aria-label", "Shape of the video");
    this.camera.setAttribute("aria-label", "Camera");
    const options = html("div", "web-video-options");
    options.append(this.shape, this.camera);

    const stage = html("div", "web-video-stage");
    this.preview.muted = true;
    this.preview.playsInline = true;
    this.preview.setAttribute("aria-label", "Camera preview");
    this.result.controls = true;
    this.result.playsInline = true;
    this.result.hidden = true;
    this.result.setAttribute("aria-label", "The video you recorded");
    stage.append(this.canvas, this.result);

    const note = html(
      "p",
      "web-video-note",
      "What you hear goes in the video: your voice with its effects, the backing track and a shared tab. Headphones keep the music out of the mic.",
    );
    const actions = html("div", "web-video-actions");
    this.again.hidden = true;
    this.save.hidden = true;
    for (const b of [this.record, this.again, this.save, this.close]) b.type = "button";
    actions.append(this.status, this.again, this.save, this.record);
    dialog.append(head, options, stage, note, actions);

    this.close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => this.dispose());
    this.shape.addEventListener("change", () => {
      writeShape(this.shape.value as Shape);
      this.fitCanvas();
    });
    this.camera.addEventListener("change", () => void this.openCamera(this.camera.value));
    this.record.addEventListener("click", () => (this.recorder ? this.stop() : this.start()));
    this.again.addEventListener("click", () => this.showLive());
    this.save.addEventListener("click", () => {
      if (this.file && this.type) download(this.file, `MicFX video ${timestamp()}.${this.type.extension}`);
    });
  }

  async open() {
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.fitCanvas();
    if (!this.type) {
      this.say("This browser can't record video.", true);
      this.record.disabled = true;
      return;
    }
    this.say("Starting the camera…");
    await this.hooks.startAudio();
    if (!this.hooks.outputStream()) {
      this.say("MicFX needs the microphone first: allow it and try again.", true);
      this.record.disabled = true;
      return;
    }
    await this.openCamera(readCamera());
  }

  private async openCamera(deviceId: string): Promise<void> {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (error) {
      if (deviceId) return this.openCamera("");
      this.say(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow the camera in the browser's address bar, then open Video again." : "No camera found.", true);
      this.record.disabled = true;
      return;
    }
    const track = this.cameraStream.getVideoTracks()[0];
    writeCamera(track?.getSettings().deviceId ?? "");
    this.preview.srcObject = this.cameraStream;
    await this.preview.play().catch(() => {});
    await this.listCameras(track?.getSettings().deviceId ?? "");
    this.record.disabled = false;
    this.say("Ready. Sing, play the backing track or a tab: what you hear is recorded.");
    this.draw();
  }

  private async listCameras(current: string) {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    this.camera.replaceChildren(...cameras.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    this.camera.value = current;
    this.camera.hidden = cameras.length < 2;
  }

  private fitCanvas() {
    const { width, height } = SHAPES[this.shape.value as Shape] ?? SHAPES.wide;
    this.canvas.width = width;
    this.canvas.height = height;
    this.dialog.dataset.shape = this.shape.value;
  }

  /**
   * The camera into the canvas, cropped from the middle to the shape. The page shows it
   * mirrored, as a mirror is; the video isn't, so writing in it reads right.
   */
  private draw() {
    cancelAnimationFrame(this.drawing);
    const context = this.canvas.getContext("2d");
    const frame = () => {
      const video = this.preview;
      const { width, height } = this.canvas;
      if (context && video.videoWidth) {
        const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        context.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
      }
      this.drawing = requestAnimationFrame(frame);
    };
    frame();
  }

  private start() {
    const sound = this.hooks.outputStream();
    if (!this.type || !sound) return;
    const picture = this.canvas.captureStream(30);
    const stream = new MediaStream([...picture.getVideoTracks(), ...sound.getAudioTracks()]);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: this.type.mime, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
    recorder.addEventListener("dataavailable", (event) => event.data.size && chunks.push(event.data));
    recorder.addEventListener("stop", () => {
      picture.getTracks().forEach((track) => track.stop());
      this.file = new Blob(chunks, { type: this.type!.mime.split(";")[0] });
      this.showResult();
    });
    recorder.start(1000);
    this.recorder = recorder;
    this.started = performance.now();
    this.record.textContent = "Stop";
    this.record.classList.add("is-recording");
    this.shape.disabled = this.camera.disabled = true;
    const tick = () => this.say(`Recording ${clock((performance.now() - this.started) / 1000)}`);
    tick();
    this.timer = window.setInterval(tick, 250);
  }

  private stop() {
    clearInterval(this.timer);
    this.recorder?.stop();
    this.recorder = undefined;
    this.record.textContent = "Record";
    this.record.classList.remove("is-recording");
    this.shape.disabled = this.camera.disabled = false;
  }

  private showResult() {
    if (!this.file) return;
    URL.revokeObjectURL(this.result.src);
    this.result.src = URL.createObjectURL(this.file);
    this.result.hidden = false;
    this.canvas.hidden = true;
    this.record.hidden = true;
    this.again.hidden = false;
    this.save.hidden = false;
    this.say(`${clock((performance.now() - this.started) / 1000)} recorded, ${(this.file.size / 1e6).toFixed(1)} MB (${this.type!.extension.toUpperCase()}). Have a look, then save it.`);
  }

  private showLive() {
    this.result.pause();
    this.result.hidden = true;
    this.canvas.hidden = false;
    this.record.hidden = false;
    this.again.hidden = true;
    this.save.hidden = true;
    this.say("Ready.");
  }

  private say(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("is-error", error);
  }

  private dispose() {
    if (this.recorder) this.stop();
    cancelAnimationFrame(this.drawing);
    clearInterval(this.timer);
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    URL.revokeObjectURL(this.result.src);
    this.dialog.remove();
  }
}

function readShape(): Shape {
  try {
    const value = localStorage.getItem("micfx.video.shape");
    return value && value in SHAPES ? (value as Shape) : "wide";
  } catch {
    return "wide";
  }
}

function writeShape(shape: Shape) {
  try {
    localStorage.setItem("micfx.video.shape", shape);
  } catch {
    // not kept
  }
}

function readCamera(): string {
  try {
    return localStorage.getItem("micfx.video.camera") ?? "";
  } catch {
    return "";
  }
}

function writeCamera(id: string) {
  try {
    localStorage.setItem("micfx.video.camera", id);
  } catch {
    // not kept
  }
}
