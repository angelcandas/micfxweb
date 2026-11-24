// MicFX DAW: the desktop app's DAW screen (extern/local-mic-effects/ui, copied to
// public/desktop at build) on the web bridge, with the desktop DAW itself (daw.wasm) in a
// worker. Every native function the DAW screen calls goes to the same C++ as on the desktop.
import { JuceBackend, type ParameterInfo } from "@micfx/bridge";
import { createChooser, download } from "./chooser";
import { DawEngine } from "./engine";
import "./web.css";

const DESKTOP = new URL("desktop/", document.baseURI).href;
const SOURCE = "https://github.com/angelcandas/micfxweb";
const MANUAL = "https://github.com/angelcandas/local-mic-effects#readme";

// Native functions answered by the engine (DawHost.cpp's Host::call).
const ENGINE_FUNCTIONS = ["daw", "getParameterDefaults", "getParameterInfo", "getPresets", "uiPref", "library", "loadPreset"];

async function boot() {
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

  engine.onEvent = (name, payload) => {
    backend.emit(name, payload);
    if (name === "dawExport") void downloadExport(engine, payload as { done?: boolean; files?: string[]; error?: string });
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

  // Browsers start sound only after a click or a key.
  const resume = () => {
    engine.resume();
    if (!interacted) { interacted = true; void followArming(engine); }
  };
  window.addEventListener("pointerdown", resume, { capture: true });
  window.addEventListener("keydown", resume, { capture: true });
  if (!engine.persistent) console.warn("MicFX DAW: this browser has no private file storage; projects last until the tab closes.");
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
  await engine.connectInput();
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
