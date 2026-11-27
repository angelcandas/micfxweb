// MicFX Voice: the desktop app's own Live UI (extern/local-mic-effects/ui, copied to
// public/desktop at build) running on the web bridge. The desktop's C++ native functions
// are played by native.ts; the effects run in the engine's AudioWorklet.
import { JuceBackend } from "@micfx/bridge";
import { createShadowEngine, LiveAudio } from "./audio";
import { createNative } from "./native";
import { addMetronome } from "./metronome-ui";
import { addShowMode } from "./show-mode";
import { addAccessibility } from "./a11y";
import { addDiagnostics } from "./diagnostics";
import { addDragAndDrop } from "./drop";
import { addSendToDaw, takeFromDaw } from "./handoff";
import { addLanguage } from "./i18n";
import { addMicHelp } from "./mic-help";
import { addCaptureLink, addPhoneLayout, addTransportMore, openCaptureOnPhones } from "./phone";
import { addPracticeProgress } from "./practice-progress";
import { addPracticeTools } from "./practice-tools";
import { addTabAudioNote } from "./tab-audio";
import { addVideo } from "./video";
import { registerOffline } from "./update";
import { addWebSettings, openSharedSound } from "./web-panels";
import "./web.css";

const DESKTOP = new URL("desktop/", document.baseURI).href;

async function boot() {
  if (openCaptureOnPhones()) return;
  const shadow = await createShadowEngine();
  const parameters = shadow.parameterInfo();
  const audio = new LiveAudio();

  const native = createNative({ shadow, audio, parameters });
  const backend = new JuceBackend({
    parameters,
    functions: native.functions,
    onParameterChanged: (id, value) => native.parameterChanged(id, value),
    onMissingFunction: (name) => console.warn(`MicFX web: "${name}" is not available yet`),
  });
  native.attach(backend);
  backend.install();

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
  await import(/* @vite-ignore */ `${DESKTOP}app.js`);
  const title = document.querySelector(".app-title");
  if (title) title.textContent = "MicFX Voice";
  document.title = "MicFX Voice";
  addSourceLink();
  addWebSettings(native.web);
  addDiagnostics(native.web);
  addMetronome(native.web);
  addShowMode();
  addVideo(native.web);
  const handoff = { tracks: native.web.tracks, notify: recorderStatus };
  addSendToDaw(handoff);
  addDragAndDrop({
    addBackingTrack: (file) => native.web.tracks.addBackingTrack(file),
    practice: (action, options) => native.web.practice.handle(action, options),
    hasPracticeSong: () => Boolean(native.web.practice.history()),
    openSoundLink: (hash) => {
      location.hash = hash; // (opened on hashchange)
      return true;
    },
    notify: recorderStatus,
  });
  addTabAudioNote();
  addMicHelp();
  addAccessibility();
  addPhoneLayout();
  addTransportMore();
  addCaptureLink();
  addPracticeProgress(native.web.practice);
  addPracticeTools(native.web.practice, native.web.startAudio);
  addLanguage();
  native.started();
  // Opened by MicFX DAW with its mix to sing over.
  void native.web.restored.then(() => takeFromDaw(handoff));
  openSharedSound(native.web);
  addEventListener("hashchange", () => openSharedSound(native.web));
  // Keeps the app's files so it opens and plays offline (production builds only).
  if (import.meta.env.PROD) registerOffline(() => native.web.busy());
}

// MicFX is free software (AGPLv3): the page says so and offers its source, as a .zip that
// every deploy builds next to the app (scripts/source-archive.sh), so it works whether the
// repository is public or not.
// Once at the foot of the window (beside the audio status) and once under the app's name
// (shown on wide windows).
function addSourceLink() {
  const make = (text: string) =>
    Object.assign(document.createElement("a"), {
      className: "web-source",
      href: SOURCE,
      download: "micfx-web-source.zip",
      textContent: text,
      title: "MicFX is free software under the GNU AGPLv3. Get the source code of this web app and the desktop app.",
    });
  document.querySelector(".app-project-label")?.after(" · ", make("Free software · source"));
  const foot = document.querySelector("footer.recorder .live-hint-line");
  const status = foot?.querySelector(".audio-status");
  if (foot) foot.insertBefore(make("Source (AGPL)"), status ?? null);
}


const SOURCE = "source.zip";

/** A line in the recorder's status (the desktop's recorderBar.setStatus). */
function recorderStatus(message: string, error = false) {
  const status = document.querySelector("footer.recorder .record-status");
  if (!status) return;
  status.textContent = message;
  status.className = `record-status ${error ? "is-error" : ""}`;
}

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<div class="boot" role="alert">Couldn't start MicFX: ${String(error instanceof Error ? error.message : error)}</div>`;
});
