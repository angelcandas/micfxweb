// Web MIDI for the DAW (plan point 25): keyboards and controllers play and record MIDI tracks
// and drive MIDI learn (the desktop's MidiMap, in the engine), and the transport sends MIDI clock
// to the outputs the person picks. MIDI is asked for only when it's wanted (the MIDI button, a
// MIDI track armed, the devices dialog), or on load once the browser has allowed it.
import { el } from "./chooser";
import type { DawEngine } from "./engine";

const STORE = "micfx.daw.midi";

interface Prefs { mutedInputs: string[]; clockOutputs: string[] }

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Prefs>;
    return { mutedInputs: saved.mutedInputs ?? [], clockOutputs: saved.clockOutputs ?? [] };
  } catch {
    return { mutedInputs: [], clockOutputs: [] };
  }
}

function savePrefs(prefs: Prefs) {
  try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* private window */ }
}

interface Transport { playing?: boolean; position?: number }

export class WebMidi {
  access: MIDIAccess | undefined;
  prefs = loadPrefs();
  private starting: Promise<boolean> | undefined;
  private tempo = 120;
  // Clock: while playing, 24 ticks a beat scheduled a little ahead with timestamps.
  private playing = false;
  private startTime = 0;   // performance.now() at startBeats
  private startBeats = 0;
  private ticksSent = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private engine: DawEngine, private onActivity: () => void = () => {}) {}

  get available() { return "requestMIDIAccess" in navigator; }

  /** Starts Web MIDI if the browser already allows it (no prompt on load). */
  async startIfAllowed() {
    try {
      const state = await navigator.permissions.query({ name: "midi" as PermissionName });
      if (state.state === "granted") await this.start();
    } catch { /* browsers without the midi permission name */ }
  }

  /** Asks for MIDI (once): true when it's on. */
  start(): Promise<boolean> {
    if (!this.available) return Promise.resolve(false);
    this.starting ??= navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      this.access = access;
      access.inputs.forEach((input) => this.attach(input));
      access.addEventListener("statechange", (event) => {
        const port = (event as MIDIConnectionEvent).port;
        if (port?.type === "input" && port.state === "connected") this.attach(port as MIDIInput);
      });
      return true;
    }).catch(() => { this.starting = undefined; return false; });
    return this.starting;
  }

  private attach(input: MIDIInput) {
    input.onmidimessage = (event) => {
      const data = event.data;
      if (!data || data.length === 0 || data[0]! >= 0xf0) return; // clock, sysex...: not for the engine
      if (this.prefs.mutedInputs.includes(input.name ?? input.id)) return;
      this.engine.midi(data[0]!, data[1] ?? 0, data[2] ?? 0);
      this.onActivity();
    };
  }

  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }

  setInputOn(name: string, on: boolean) {
    this.prefs.mutedInputs = this.prefs.mutedInputs.filter((n) => n !== name).concat(on ? [] : [name]);
    savePrefs(this.prefs);
  }

  setClock(name: string, on: boolean) {
    this.prefs.clockOutputs = this.prefs.clockOutputs.filter((n) => n !== name).concat(on ? [name] : []);
    savePrefs(this.prefs);
  }

  private clockOutputs() {
    return this.outputs().filter((o) => this.prefs.clockOutputs.includes(o.name ?? o.id));
  }

  private send(data: number[], time?: number) {
    for (const output of this.clockOutputs()) {
      try { output.send(data, time); } catch { /* unplugged */ }
    }
  }

  setTempo(tempo: number | undefined) {
    if (!tempo || tempo <= 0 || tempo === this.tempo) return;
    // Keep the beat where it is, from now on at the new tempo.
    if (this.playing) {
      const now = performance.now();
      this.startBeats = this.beatsAt(now);
      this.startTime = now;
      this.ticksSent = 0;
    }
    this.tempo = tempo;
  }

  private beatsAt(time: number) { return this.startBeats + ((time - this.startTime) / 60_000) * this.tempo; }

  /** From the DAW's status (30 times a second): start, follow and stop the clock. */
  follow(status: Transport) {
    if (!this.access || !this.prefs.clockOutputs.length) { this.playing = Boolean(status.playing); return; }
    const now = performance.now();
    const beats = ((status.position ?? 0) * this.tempo) / 60;

    if (status.playing && !this.playing) this.startClock(now, beats);
    else if (!status.playing && this.playing) this.stopClock();
    else if (status.playing && Math.abs(this.beatsAt(now) - beats) > 0.25) {
      // Jumped (a locate or a loop): stop, point at the new place and go on.
      this.send([0xfc]);
      this.startClock(now, beats);
    }
  }

  private startClock(now: number, beats: number) {
    const sixteenths = Math.max(0, Math.min(16383, Math.round(beats * 4)));
    this.send([0xf2, sixteenths & 0x7f, (sixteenths >> 7) & 0x7f]);
    this.send([sixteenths === 0 ? 0xfa : 0xfb]);
    this.playing = true;
    this.startTime = now;
    this.startBeats = sixteenths / 4;
    this.ticksSent = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 20);
    this.schedule();
  }

  private schedule() {
    const horizon = performance.now() + 80;
    const tickMs = 60_000 / this.tempo / 24;
    for (;;) {
      const at = this.startTime + this.ticksSent * tickMs;
      if (at > horizon) break;
      this.send([0xf8], Math.max(at, performance.now()));
      this.ticksSent++;
    }
  }

  private stopClock() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.playing = false;
    this.send([0xfc]);
  }
}

/** The MIDI devices: which inputs play, which outputs get the clock. */
export async function showMidiDevices(midi: WebMidi) {
  const on = await midi.start();
  const backdrop = el("div", "web-dialog-backdrop");
  const dialog = el("div", "web-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "MIDI devices");
  const list = el("div", "web-dialog-list web-midi-list");
  const row = (label: string, hint: string, checked: boolean, change: (on: boolean) => void) => {
    const line = el("label", "web-midi-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => change(box.checked));
    line.append(box, el("span", "", label), el("span", "web-menu-hint", hint));
    return line;
  };
  const inputs = midi.inputs();
  const outputs = midi.outputs();
  list.append(el("h3", "web-midi-head", "Inputs"));
  if (!on) list.append(el("div", "web-dialog-empty", midi.available ? "MIDI isn't allowed for this page. Allow it in the browser's site settings." : "This browser has no Web MIDI (Chrome, Edge and Firefox do)."));
  else if (!inputs.length) list.append(el("div", "web-dialog-empty", "No MIDI inputs. Plug in a keyboard or controller."));
  for (const input of inputs) {
    const name = input.name ?? input.id;
    list.append(row(name, "Plays and records MIDI tracks, and drives MIDI learn", !midi.prefs.mutedInputs.includes(name), (v) => midi.setInputOn(name, v)));
  }
  list.append(el("h3", "web-midi-head", "Outputs"));
  if (on && !outputs.length) list.append(el("div", "web-dialog-empty", "No MIDI outputs."));
  for (const output of outputs) {
    const name = output.name ?? output.id;
    list.append(row(name, "Sends MIDI clock, start and stop with the transport", midi.prefs.clockOutputs.includes(name), (v) => midi.setClock(name, v)));
  }
  const close = el("button", "web-dialog-primary", "Done");
  close.type = "button";
  const buttons = el("div", "web-dialog-buttons");
  buttons.append(el("span", "web-dialog-gap"), close);
  dialog.append(el("h2", "web-dialog-title", "MIDI devices"), list, buttons);
  backdrop.append(dialog);
  document.body.append(backdrop);
  const finish = () => { backdrop.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" || event.key === "Enter") { event.stopPropagation(); finish(); } };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", finish);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(); });
  close.focus();
}
