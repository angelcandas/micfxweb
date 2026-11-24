// Spanish (plan section 9, point 13). The desktop's Live UI is English text in its HTML and
// its script, so the web translates what the page shows: text nodes, and the title,
// aria-label, placeholder and data-tip attributes, through the dictionary and patterns in
// i18n/es.ts. Only text that is exactly a key changes, so names (presets, takes, songs) stay.
// A MutationObserver keeps it Spanish as the app redraws.
//
// Settings › Look › Language: Automatic (the browser's language), English or Español.
// It's kept in localStorage and applies after a reload.
import { ES, ES_PATTERNS } from "./i18n/es";

const KEY = "micfx.language";
const ATTRIBUTES = ["title", "aria-label", "placeholder", "data-tip"] as const;
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"]);

export type Language = "auto" | "en" | "es";

export function languageSetting(): Language {
  try {
    const value = localStorage.getItem(KEY);
    return value === "en" || value === "es" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** The language the page shows: the setting, or the browser's first language when automatic. */
export function pageLanguage(setting = languageSetting(), languages: readonly string[] = navigator.languages ?? [navigator.language]): "en" | "es" {
  if (setting !== "auto") return setting;
  return (languages[0] ?? "").toLowerCase().startsWith("es") ? "es" : "en";
}

/** One string in Spanish, keeping its surrounding whitespace; undefined when there's no translation. */
export function translate(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 400) return undefined;
  let out = ES[trimmed];
  if (out === undefined) {
    for (const [pattern, replacement] of ES_PATTERNS) {
      if (!pattern.test(trimmed)) continue;
      out = typeof replacement === "string" ? trimmed.replace(pattern, replacement) : trimmed.replace(pattern, (_all, ...groups: string[]) => replacement(...groups));
      break;
    }
  }
  if (out === undefined || out === trimmed) return undefined;
  const start = text.length - text.trimStart().length;
  return text.slice(0, start) + out + text.slice(start + trimmed.length);
}

function translateText(node: Text) {
  const parent = node.parentElement;
  if (!parent || SKIP.has(parent.tagName) || parent.isContentEditable) return;
  const out = translate(node.data);
  if (out !== undefined) node.data = out;
}

function translateAttributes(element: Element) {
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const out = translate(value);
    if (out !== undefined) element.setAttribute(name, out);
  }
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root instanceof Element) {
    if (SKIP.has(root.tagName)) return;
    translateAttributes(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node instanceof Element && SKIP.has(node.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateText(node as Text);
    else translateAttributes(node as Element);
  }
}

/** Settings › Look › Language, then the page in Spanish when that's the language. */
export function addLanguage() {
  addLanguageSetting();
  const language = pageLanguage();
  document.documentElement.lang = language;
  if (language !== "es") return;
  translateTree(document.body);
  if (document.title === "MicFX Voice") document.title = "MicFX Voz";
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(translateTree);
      else if (record.type === "characterData") translateText(record.target as Text);
      else if (record.type === "attributes") translateAttributes(record.target as Element);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRIBUTES] });
}

function addLanguageSetting() {
  const look = [...document.querySelectorAll(".settings-window .setup-section")].find((section) => section.querySelector("h3")?.textContent === "Look");
  if (!look || look.querySelector(".web-language-row")) return;
  const row = Object.assign(document.createElement("div"), { className: "setup-row web-language-row" });
  const caption = Object.assign(document.createElement("span"), { className: "setup-row-label", textContent: "Language" });
  const select = Object.assign(document.createElement("select"), { className: "dropdown web-language", title: "The language of the app (reloads the page)" });
  select.setAttribute("aria-label", "Language");
  for (const [value, text] of [["auto", "Automatic"], ["en", "English"], ["es", "Español"]] as const)
    select.append(Object.assign(document.createElement("option"), { value, textContent: text }));
  select.value = languageSetting();
  select.addEventListener("change", () => {
    try {
      if (select.value === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, select.value);
    } catch {
      // not kept
    }
    location.reload();
  });
  row.append(caption, select);
  look.append(row);
}
