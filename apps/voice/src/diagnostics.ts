// Diagnostics (plan section 9, point 30): Settings › Diagnostics shows how the sound runs here
// (device, rate, buffer, round trip, the engine's load and dropouts) and what this browser is,
// with "Copy for support". The engine is built with WebAssembly SIMD; while it runs, a load
// that stays high says so before the sound breaks up.
import { toast } from "./web-panels";

declare const __MICFX_BUILD__: string;

export interface DiagnosticsHooks {
  diagnostics(): {
    running: boolean;
    device: string;
    rate: number;
    buffer: number;
    latencyMs: number;
    effectsMs: number;
    cpu: number;
    cpuPeak: number;
    xruns: number;
    roundTripMeasured?: number;
  };
}

/** Whether this browser runs WebAssembly SIMD (the engine needs it). */
export function hasSimd(): boolean {
  // (a function with one v128 constant: valid only where SIMD is)
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11];
  try {
    return WebAssembly.validate(new Uint8Array(bytes));
  } catch {
    return false;
  }
}

/** The browser and system, briefly, from the user agent. */
export function browserText(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /OPR\/(\d+)/.exec(ua) ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+)[\d.]* .*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : "Another browser";
  const system = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "another system";
  return `${browser} on ${system}`;
}

/** The rows, as label and value. */
export function diagnosticsRows(d: ReturnType<DiagnosticsHooks["diagnostics"]>): [string, string][] {
  const block = d.rate ? (d.buffer / d.rate) * 1000 : 0;
  return [
    ["MicFX Voice", typeof __MICFX_BUILD__ === "string" ? __MICFX_BUILD__ : "dev"],
    ["Browser", browserText(navigator.userAgent)],
    ["Sound", d.running ? "running" : "off (starts with the first click)"],
    ["Input", d.device],
    ["Sample rate", `${(d.rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`],
    ["Buffer", `${d.buffer} samples (${block.toFixed(1)} ms)`],
    ["Round trip", `${Math.round(d.latencyMs + d.effectsMs)} ms${d.roundTripMeasured ? " (measured here)" : " (the browser's estimate)"}`],
    ["Engine load", d.running ? `${Math.round(d.cpu)} % now, ${Math.round(d.cpuPeak)} % at most in the last 10 s` : "–"],
    ["Dropouts", d.running ? String(d.xruns) : "–"],
    ["WebAssembly SIMD", hasSimd() ? "yes" : "no (the engine can't run)"],
    ["Audio worklet", typeof AudioWorkletNode === "function" ? "yes" : "no"],
    ["Cores", String(navigator.hardwareConcurrency ?? "?")],
    ["Screen", `${screen.width}×${screen.height} at ${devicePixelRatio}×`],
    ["Language", navigator.language],
  ];
}

export function addDiagnostics(hooks: DiagnosticsHooks) {
  const body = document.querySelector<HTMLElement>(".settings-window .setup-body");
  if (!body || body.querySelector(".web-diagnostics")) return;
  const section = Object.assign(document.createElement("section"), { className: "setup-section web-settings web-diagnostics" });
  section.append(Object.assign(document.createElement("h3"), { textContent: "Diagnostics" }));
  const list = Object.assign(document.createElement("dl"), { className: "web-diagnostics-list" });
  const copy = Object.assign(document.createElement("button"), {
    type: "button",
    className: "tool web-diagnostics-copy",
    textContent: "Copy for support",
    title: "Copies these lines, to paste in a message when something sounds wrong. Nothing is sent anywhere.",
  });
  copy.addEventListener("click", async () => {
    const text = diagnosticsRows(hooks.diagnostics()).map(([k, v]) => `${k}: ${v}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it in your message.");
    } catch {
      toast("The browser wouldn't copy. Select the lines and copy them.");
    }
  });
  section.append(list, copy);
  body.append(section);

  const render = () => {
    const rows = diagnosticsRows(hooks.diagnostics());
    if (list.children.length !== rows.length * 2) {
      list.replaceChildren(...rows.flatMap(() => [document.createElement("dt"), document.createElement("dd")]));
    }
    rows.forEach(([label, value], i) => {
      const dt = list.children[i * 2]!;
      const dd = list.children[i * 2 + 1]!;
      if (dt.textContent !== label) dt.textContent = label;
      if (dd.textContent !== value) dd.textContent = value;
    });
  };
  render();
  // While Settings is open, once a second.
  setInterval(() => {
    if (section.offsetParent !== null) render();
  }, 1000);

  watchLoad(hooks);
}

/**
 * A load that stays high is said once, before the sound breaks up: over 80 % for 3 seconds,
 * or new dropouts. Then quiet for a minute.
 */
function watchLoad(hooks: DiagnosticsHooks) {
  let highSince = 0;
  let lastXruns = 0;
  let quietUntil = 0;
  setInterval(() => {
    const d = hooks.diagnostics();
    if (!d.running) return;
    const now = performance.now();
    highSince = d.cpu >= 80 ? highSince || now : 0;
    const dropped = d.xruns > lastXruns;
    lastXruns = d.xruns;
    if (now < quietUntil) return;
    if ((highSince && now - highSince > 3000) || dropped) {
      quietUntil = now + 60_000;
      toast(
        dropped
          ? "The sound broke up: the effects needed more time than the browser gave them. Turn some effects off, or close other tabs."
          : `The effects are using ${Math.round(d.cpu)} % of the time they have. Turn some off, or close other tabs, before the sound breaks up.`,
      );
    }
  }, 500);
}
