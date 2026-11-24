// Microphone permission help (plan section 9, point 12): when the browser says no, the steps
// to allow MicFX for this browser, on the first-run card and in the error itself, with a
// "Try again". The first-run card's other steps are the desktop's (headphones, Mic check,
// Sound check: sing 10 to 20 seconds and the chain is set for your voice).

export type BrowserKind = "chrome" | "edge" | "firefox" | "safari" | "ios" | "android" | "other";

export function browserKind(ua = navigator.userAgent, touch = navigator.maxTouchPoints ?? 0): BrowserKind {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\/|Chromium\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

const STEPS: Record<BrowserKind, string> = {
  chrome: "Click the icon at the left of the address bar, turn Microphone on (or pick Allow), then press Try again.",
  edge: "Click the lock at the left of the address bar, set Microphone to Allow, then press Try again.",
  firefox: "Click the crossed-out microphone in the address bar and clear “Blocked”, then press Try again: Firefox asks once more.",
  safari: "In the menu bar, pick Safari › Settings for This Website…, set Microphone to Allow, then press Try again.",
  ios: "Tap “aA” in the address bar › Website Settings › Microphone › Allow, then Try again. From the Home Screen app: Settings › Privacy & Security › Microphone.",
  android: "Tap the icon at the left of the address bar › Permissions › Microphone › Allow, then Try again.",
  other: "Allow the microphone for this site in the browser's address bar, then press Try again.",
};

/** What to do in this browser when the microphone is blocked. */
export function micHelp(kind = browserKind()): string {
  return STEPS[kind];
}

/** When it's allowed and still nothing: the computer's own switch. */
export const SYSTEM_HELP =
  "Still nothing? The computer may block the browser: on a Mac, System Settings › Privacy & Security › Microphone; on Windows, Settings › Privacy & security › Microphone.";

/** Fired by the page when starting the sound met a "no" from the browser. */
export const MIC_DENIED_EVENT = "micfx:mic-denied";

async function micState(): Promise<PermissionState | undefined> {
  try {
    return (await navigator.permissions?.query({ name: "microphone" as PermissionName }))?.state;
  } catch {
    return undefined; // not asked about in this browser (older Safari, Firefox)
  }
}

/** The help on the first-run card, under its first step, while the microphone is blocked. */
export function addMicHelp() {
  const body = document.querySelector(".first-run .setup-body");
  const first = body?.querySelector(".setup-step");
  if (!body || !first || body.querySelector(".web-mic-help")) return;
  const help = document.createElement("div");
  help.className = "web-mic-help";
  help.setAttribute("role", "alert");
  help.hidden = true;
  const title = Object.assign(document.createElement("strong"), { textContent: "MicFX can't hear your microphone yet" });
  const steps = Object.assign(document.createElement("p"), { textContent: micHelp() });
  const system = Object.assign(document.createElement("p"), { className: "web-mic-system", textContent: SYSTEM_HELP });
  const retry = Object.assign(document.createElement("button"), { type: "button", className: "tool is-accent", textContent: "Try again" });
  // "I'm wearing headphones" starts the sound: the same click asks for the mic again.
  retry.addEventListener("click", () => {
    help.hidden = true;
    (body.querySelector(".setup-step .tool.is-accent") as HTMLButtonElement | null)?.click();
    void check();
  });
  help.append(title, steps, system, retry);
  first.after(help);

  const show = () => (help.hidden = false);
  const check = async () => {
    if ((await micState()) === "denied") show();
  };
  addEventListener(MIC_DENIED_EVENT, show);
  void check();
  void navigator.permissions
    ?.query({ name: "microphone" as PermissionName })
    .then((status) => status.addEventListener("change", () => (status.state === "denied" ? show() : (help.hidden = true))))
    .catch(() => {});
}
