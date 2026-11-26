// MicFX DAW: the desktop app's DAW screen (extern/local-mic-effects/ui, copied to
// public/desktop at build) on the web bridge, with the desktop DAW itself (daw.wasm) in a
// worker. Every native function the DAW screen calls goes to the same C++ as on the desktop.
import { JuceBackend, type ParameterInfo } from "@micfx/bridge";
import { createChooser, download } from "./chooser";
import { DawEngine } from "./engine";
import { connectSavedInputs, showInputs } from "./inputs";
import { showMidiDevices, WebMidi } from "./midi";
import { sendMixToVoice, takeInbox } from "./partner";
import { partnerUrl } from "@micfx/handoff";
import { addAutosaveStatus, flushOnHide } from "./versions";
import { showAudioSettings } from "./audio-settings";
import "./web.css";

const DESKTOP = new URL("desktop/", document.baseURI).href;
const SOURCE = "https://github.com/angelcandas/micfxweb";
const MANUAL = "https://github.com/angelcandas/local-mic-effects#readme";

// Native functions answered by the engine (DawHost.cpp's Host::call).
const ENGINE_FUNCTIONS = ["daw", "getParameterDefaults", "getParameterInfo", "getPresets", "uiPref", "library", "loadPreset", "midi"];

// A phone has no room for the DAW (the desktop's tracks, clips and menus need a pointer and a
// wide screen): it gets a short page that points to MicFX Voice, where ideas are captured.
// "?desktop" opens the DAW anyway.
const PHONE = matchMedia("(max-width: 760px) and (pointer: coarse)").matches && !location.search.includes("desktop");

function showPhonePage() {
  const voice = partnerUrl("daw", location).replace(/handoff\.html$/, "");
  document.body.innerHTML = `<main class="web-phone-page">
    <h1>MicFX DAW needs a bigger screen</h1>
    <p>Arranging, editing and mixing a song takes room and a mouse or a pen. Open this page on a computer or a tablet held sideways.</p>
    <p>On your phone, <strong>catch the idea</strong> in MicFX Voice. It saves every recording on this device, and you can send it here later.</p>
    <a class="web-phone-primary" href="${voice}capture.html">Record an idea</a>
    <a class="web-phone-secondary" href="?desktop">Open the DAW anyway</a>
  </main>`;
  document.title = "MicFX DAW";
}

async function boot() {
  if (PHONE) return showPhonePage();
  if (!crossOriginIsolated) throw new Error("This page needs cross-origin isolation (the DAW engine runs on threads).");

  const engine = new DawEngine();
  await engine.start();
  (window as unknown as { micfxDaw: DawEngine }).micfxDaw = engine; // for checks and support

  const parameters = (await engine.call("getParameterInfo", [])) as Record<string, ParameterInfo>;

  const functions: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of ENGINE_FUNCTIONS) functions[name] = (...args: unknown[]) => engine.call(name, args);
  functions.window = (action?: unknown) => {
    if (action === "fullScreen") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.();
    }
    return { available: true, fullScreen: Boolean(document.fullscreenElement) };
  };
  functions.help = () => { window.open(MANUAL, "_blank", "noopener"); return true; };
  functions.logError = (message: unknown) => { console.error(`[MicFX UI] ${String(message)}`); return null; };

  const backend = new JuceBackend({
    parameters,
    functions,
    onMissingFunction: (name) => console.info(`MicFX DAW: "${name}" is a Live mode feature, not in the web DAW`),
  });
  backend.install();

  let autosave: ReturnType<typeof addAutosaveStatus> | undefined;
  let handoffExport: ((path: string | undefined) => void) | undefined;
  const midi = new WebMidi(engine, flashMidi);
  engine.onEvent = (name, payload) => {
    if (name === "webSaved") { autosave?.saved((payload as { time: number }).time); return; }
    backend.emit(name, payload);
    if (name === "dawStatus") midi.follow(payload as { playing?: boolean; position?: number });
    if (name === "dawSession") {
      const session = payload as { tempo?: number; tracks?: { kind?: string; arm?: boolean }[] };
      midi.setTempo(session.tempo);
      if (session.tracks?.some((t) => t.kind === "midi" && t.arm)) void midi.start();
    }
    if (name === "dawExport") {
      const result = payload as { done?: boolean; files?: string[]; error?: string };
      if (result.done && handoffExport) { handoffExport(result.error || !result.files?.[0] ? undefined : result.files[0]); handoffExport = undefined; }
      else void downloadExport(engine, result);
    }
    if (name === "dawSession") void followArming(engine, payload as { tracks?: { arm?: boolean }[] });
  };
  engine.onChooser = createChooser(engine);

  // The DAW screen opens in DAW mode; Live mode is MicFX Voice's.
  await engine.call("daw", ["mode", { daw: true }]);

  // The desktop page: its stylesheets and body, then its script.
  const page = new DOMParser().parseFromString(await (await fetch(`${DESKTOP}index.html`)).text(), "text/html");
  const styles = [...page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = new URL(link.getAttribute("href")!, DESKTOP).href;
    document.head.append(style);
    return new Promise((resolve) => style.addEventListener("load", resolve, { once: true }));
  });
  await Promise.all(styles);
  document.body.innerHTML = page.body.innerHTML;
  document.body.className = page.body.className;
  document.body.dataset.platform = "web";
  document.body.dataset.webApp = "daw";
  await import(/* @vite-ignore */ `${DESKTOP}app.js`);
  document.title = "MicFX DAW";
  const title = document.querySelector(".app-title");
  if (title) title.textContent = "MicFX DAW";
  addSourceLink();
  autosave = addAutosaveStatus(engine, [
    { label: "Audio settings…", hint: "Sample rate, low latency and the delay you hear", action: async () => showAudioSettings(engine) },
    { label: "Audio inputs…", hint: "Microphones and interfaces to record from, several at once", action: () => showInputs(engine, () => void engine.call("daw", ["session", {}]).then((s) => backend.emit("dawSession", s))) },
    {
      label: "Send the mix to MicFX Voice…",
      hint: "Sing or practise over this song in MicFX Voice",
      action: async () => {
        const session = (await engine.call("daw", ["session", {}])) as { project?: { name?: string } };
        await sendMixToVoice(engine, session.project?.name ?? "Song", () => new Promise((resolve) => { handoffExport = resolve; }));
      },
    },
    { label: "MIDI devices…", hint: "Keyboards and controllers to play with, and where to send MIDI clock", action: () => showMidiDevices(midi) },
  ]);
  // MIDI learn and MIDI tracks need MIDI: asked for when the MIDI button is first used.
  document.querySelector(".midi-button")?.addEventListener("click", () => void midi.start(), { capture: true });
  void midi.startIfAllowed();

  // Takes MicFX Voice sent (handoff.html opened the DAW with them).
  void takeInbox(engine).then((said) => { if (said) autosave?.say(said); }).catch((error) => console.warn("MicFX DAW: couldn't take what MicFX Voice sent", error));
  flushOnHide(engine);

  // Browsers start sound only after a click or a key.
  const resume = () => {
    engine.resume();
    if (!interacted) { interacted = true; void followArming(engine); }
  };
  window.addEventListener("pointerdown", resume, { capture: true });
  window.addEventListener("keydown", resume, { capture: true });
  if (!engine.persistent) console.warn("MicFX DAW: this browser has no private file storage; projects last until the tab closes.");
}

// The MIDI button's activity light (the desktop sets it from its status event).
let flashTimer = 0;
function flashMidi() {
  const now = performance.now();
  if (now - flashTimer < 120) return;
  flashTimer = now;
  const button = document.querySelector(".midi-button");
  if (!button) return;
  button.classList.remove("is-receiving");
  void (button as HTMLElement).offsetWidth;
  button.classList.add("is-receiving");
}

// Rendered files (Export, Bounce to file) go to the computer as downloads.
async function downloadExport(engine: DawEngine, event: { done?: boolean; files?: string[]; error?: string }) {
  if (!event.done || event.error || !event.files) return;
  for (const path of event.files) {
    try {
      download(path.slice(path.lastIndexOf("/") + 1), await engine.readFile(path));
    } catch (error) {
      console.warn("MicFX DAW: couldn't download", path, error);
    }
  }
}

// The microphone is asked for once the person has used the page and a track is armed to
// record (not on load: a permission prompt before anything is clicked is unwelcome).
let lastSession: { tracks?: { arm?: boolean }[] } = {};
let interacted = false;
async function followArming(engine: DawEngine, session?: { tracks?: { arm?: boolean }[] }) {
  if (session) lastSession = session;
  if (!interacted || engine.inputChannels > 0 || !lastSession.tracks?.some((t) => t.arm)) return;
  await connectSavedInputs(engine);
}

// MicFX is free software (AGPLv3): the page says so and links to its source.
function addSourceLink() {
  const link = Object.assign(document.createElement("a"), {
    className: "web-source",
    href: SOURCE,
    target: "_blank",
    rel: "noopener",
    textContent: "Free software · source",
    title: "MicFX is free software under the GNU AGPLv3. Get the source code of this web app and the desktop app.",
  });
  document.querySelector(".app-project-label")?.after(" · ", link);
}

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<div class="boot" role="alert">Couldn't start MicFX DAW: ${String(error instanceof Error ? error.message : error)}</div>`;
});
