// The web's "Audio settings…": the browser has no device dialog of its own, so this is a
// small one in the desktop's settings style (its modal() and setup-* classes): which mic,
// which output (where the browser can choose), start or stop the sound, and the latency.
import type { LiveAudio } from "./audio";

const DESKTOP = new URL("desktop/", document.baseURI).href;
const INPUT_KEY = "micfx.audio.input";
const OUTPUT_KEY = "micfx.audio.output";

type Modal = (className: string, title: string, onClose: () => void) => { backdrop: HTMLElement; body: HTMLElement };

function pref(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export const savedInput = () => pref(INPUT_KEY);
export const savedOutput = () => pref(OUTPUT_KEY);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

export function createAudioSettings(audio: LiveAudio, start: () => Promise<unknown>, changed: () => void) {
  let dialog: { backdrop: HTMLElement; body: HTMLElement } | undefined;
  const canPickOutput = typeof (AudioContext.prototype as unknown as { setSinkId?: unknown }).setSinkId === "function";

  const input = el("select", "dropdown");
  input.setAttribute("aria-label", "Microphone");
  const output = el("select", "dropdown");
  output.setAttribute("aria-label", "Output");
  const power = el("button", "tool is-accent");
  power.type = "button";
  const latency = el("span", "setup-value");
  const note = el("p", "setup-lead");

  input.addEventListener("change", async () => {
    pref(INPUT_KEY, input.value);
    if (audio.running) {
      await audio.stop();
      await start();
    }
    changed();
    render();
  });
  output.addEventListener("change", async () => {
    pref(OUTPUT_KEY, output.value);
    await audio.setOutput(output.value).catch(() => {});
    render();
  });
  power.addEventListener("click", async () => {
    if (audio.running) await audio.stop();
    else await start();
    changed();
    render();
  });

  const fill = (select: HTMLSelectElement, devices: MediaDeviceInfo[], chosen: string, fallback: string) => {
    select.replaceChildren(new Option(fallback, ""), ...devices.map((d, i) => new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
    select.value = devices.some((d) => d.deviceId === chosen) ? chosen : "";
  };

  async function render() {
    const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
    fill(input, devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default"), savedInput(), "Default microphone");
    fill(output, devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default"), savedOutput(), "Default output");
    power.textContent = audio.running ? "Stop sound" : "Start sound";
    const ms = audio.latencyMs();
    latency.textContent = ms === undefined ? "Start the sound to measure it" : `About ${Math.round(ms)} ms from your voice to your ears`;
    note.textContent = devices.every((d) => !d.label)
      ? "Start the sound once to see your devices' names (the browser shows them after you allow the mic)."
      : "Wired headphones keep the delay low. Bluetooth adds 100 ms or more, too much to sing with.";
  }

  return {
    async open() {
      if (!dialog) {
        const { modal } = (await import(/* @vite-ignore */ `${DESKTOP}setup.js`)) as { modal: Modal };
        dialog = modal("web-audio-settings", "Audio settings", () => (dialog!.backdrop.hidden = true));
        const section = el("section", "setup-section");
        const row = (label: string, ...controls: HTMLElement[]) => {
          const r = el("div", "setup-row");
          r.append(el("span", "setup-row-label", label), ...controls);
          section.append(r);
          return r;
        };
        row("Microphone", input);
        row("Output", output).hidden = !canPickOutput;
        row("Sound", power);
        row("Latency", latency);
        dialog.body.append(section, note);
      }
      await render();
      dialog.backdrop.hidden = false;
      input.focus();
    },
  };
}
