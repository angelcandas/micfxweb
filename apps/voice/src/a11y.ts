// The accessibility pass (plan section 9, point 14), over the desktop UI as the web shows it:
//
// - Every control has a name a screen reader can say: inputs and lists named only by a
//   tooltip (which the desktop moves into data-tip on hover) get it as their label.
// - The foot's hint line isn't hidden from screen readers any more (it holds the source
//   link and the audio status button); only its hover text is, as that text is each
//   control's own name.
// - Practice is the page's main part while it shows, as the effects are otherwise.
// - The page keeps its heading (the app's name) on narrow windows, for screen readers.
// - Settings › Look: High contrast and Reduce motion, each following the system unless set.
//   Keyboard focus shows as a clear ring everywhere.

const KEY = "micfx.a11y";

interface Prefs {
  contrast?: boolean;
  motion?: boolean; // true: reduce
}

function read(): Prefs {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Prefs) ?? {};
  } catch {
    return {};
  }
}

function write(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // not kept
  }
}

const systemContrast = () => matchMedia("(prefers-contrast: more)").matches;
const systemMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The tooltip's name part: its first line, without a "(Ctrl+K)" shortcut. */
export function tipName(tip: string): string {
  return (tip.split("\n")[0] ?? "").replace(/\s*\((?:[^()]*\+[^()]*|[A-Z0-9]|F\d+|Space|Esc)\)\s*$/, "").trim();
}

/** Whether a form control has a name that isn't only its tooltip. */
function named(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  if (element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")) return true;
  return Boolean(element.labels && [...element.labels].some((label) => label.textContent?.trim()));
}

/** Names the form controls that only have a tooltip. */
export function nameControls(root: ParentNode = document) {
  for (const element of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]), select, textarea")) {
    if (named(element)) continue;
    const tip = element.getAttribute("title") || element.dataset.tip || element.getAttribute("placeholder") || "";
    // A Settings row's caption beside it.
    const caption = element.closest(".setup-row")?.querySelector(".setup-row-label")?.textContent?.trim() ?? "";
    const name = tipName(tip) || caption;
    if (name) element.setAttribute("aria-label", name);
  }
}

function applyLook(prefs: Prefs) {
  const contrast = prefs.contrast ?? systemContrast();
  const reduce = prefs.motion ?? systemMotion();
  document.body.classList.toggle("web-contrast", contrast);
  document.body.classList.toggle("web-reduce-motion", reduce);
}

export function addAccessibility() {
  const hint = document.querySelector(".live-hint-line");
  hint?.removeAttribute("aria-hidden");
  hint?.querySelectorAll(".hint-text, .hint-key").forEach((part) => part.setAttribute("aria-hidden", "true"));
  // Practice takes the effects' place: it's the page's main part while it shows.
  document.querySelector("section.practice")?.setAttribute("role", "main");

  // The desktop builds panels as they open: name their controls as they come.
  nameControls();
  let pending = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      nameControls();
    });
  }).observe(document.body, { childList: true, subtree: true });

  const prefs = read();
  applyLook(prefs);
  for (const query of ["(prefers-contrast: more)", "(prefers-reduced-motion: reduce)"]) matchMedia(query).addEventListener("change", () => applyLook(read()));
  addLookSettings();
}

/** High contrast and Reduce motion in Settings › Look. */
function addLookSettings() {
  const look = [...document.querySelectorAll(".settings-window .setup-section")].find((section) => section.querySelector("h3")?.textContent === "Look");
  if (!look || look.querySelector(".web-contrast-row")) return;
  const row = (className: string, label: string, text: string, title: string, get: () => boolean, set: (on: boolean) => void) => {
    const element = document.createElement("div");
    element.className = `setup-row ${className}`;
    const caption = Object.assign(document.createElement("span"), { className: "setup-row-label", textContent: label });
    const check = Object.assign(document.createElement("label"), { className: "setup-check", title });
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: get() });
    box.addEventListener("change", () => set(box.checked));
    check.append(box, Object.assign(document.createElement("span"), { textContent: text }));
    element.append(caption, check);
    look.append(element);
    return box;
  };
  const update = (change: Prefs) => {
    const prefs = { ...read(), ...change };
    write(prefs);
    applyLook(prefs);
  };
  row("web-contrast-row", "Contrast", "High contrast", "Brighter text and lines, stronger edges (follows the system's setting until you change it)", () => document.body.classList.contains("web-contrast"), (on) => update({ contrast: on }));
  row("web-motion-row", "Motion", "Reduce motion", "No animations or slides (follows the system's setting until you change it)", () => document.body.classList.contains("web-reduce-motion"), (on) => update({ motion: on }));
}
