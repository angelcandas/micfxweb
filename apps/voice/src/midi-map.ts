// MIDI learn for Live mode on the web: the desktop's MidiMap (src/MidiMap.cpp) driven by
// Web MIDI. Pedals, knobs, keys and program changes drive any parameter ("param:<id>") or
// an action ("action:<name>"): preset.next / preset.previous, mute, scene.next,
// scene.previous, scene.1 ... scene.8, and the page's own (record, looper.*).
//
// Same rules as the desktop: a CC moves a knob only once it picks up the current value, a
// key / pedal press / program change flips switches, steps choices and flips knobs between
// their ends, and a pedal "presses" when its CC crosses 64 upwards.
import { fromNormalised, toNormalised, type ParameterAccess } from "./live-state";

export type MidiSource = "cc" | "note" | "program";

export interface Mapping {
  source: MidiSource;
  channel: number; // 1..16
  number: number; // 0..127
  target: string;
}

interface MidiEvent {
  source: MidiSource;
  channel: number;
  number: number;
  value: number; // CC 0..127, velocity, 0 for a program change
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** "CC 64 · ch 1", "Note C3 · ch 2", "Program 5 · ch 1" (middle C is C3, as JUCE names it). */
export function describeSource(m: Pick<Mapping, "source" | "channel" | "number">): string {
  const channel = ` · ch ${m.channel}`;
  if (m.source === "note") return `Note ${NOTE_NAMES[m.number % 12]}${Math.floor(m.number / 12) - 2}${channel}`;
  if (m.source === "program") return `Program ${m.number + 1}${channel}`;
  return `CC ${m.number}${channel}`;
}

/** A raw MIDI message to an event, or undefined for the kinds MIDI learn ignores. */
export function parseMidi(data: ArrayLike<number>): MidiEvent | undefined {
  const status = data[0] ?? 0;
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1] ?? 0;
  const value = data[2] ?? 0;
  if (kind === 0xb0) return { source: "cc", channel, number, value };
  if (kind === 0x90 && value > 0) return { source: "note", channel, number, value };
  if (kind === 0xc0) return { source: "program", channel, number, value: 0 };
  return undefined;
}

const sameSource = (a: Pick<Mapping, "source" | "channel" | "number">, b: Pick<Mapping, "source" | "channel" | "number">) =>
  a.source === b.source && a.channel === b.channel && a.number === b.number;

export class MidiMap {
  /** Mappings changed (to keep them). */
  onMappingsChanged: (mappings: Mapping[]) => void = () => {};
  onLearned: (mapping: Mapping) => void = () => {};
  onPresetStep: (delta: number) => void = () => {};
  onMuteToggle: () => void = () => {};
  onScene: (action: string) => void = () => {};
  /** Actions the page runs itself (record, looper.*). */
  onAction: (action: string) => void = () => {};

  learning = "";
  lastEvent = "";
  eventCount = 0;
  private mappings: Mapping[] = [];
  private lastCc = new Uint8Array(16 * 128);
  private ccSeen = new Uint8Array(16 * 128);
  private pickedUp = new Map<string, boolean>();
  private lastSet = new Map<string, number>();

  constructor(private readonly params: ParameterAccess) {}

  getMappings(): Mapping[] {
    return this.mappings.map((m) => ({ ...m }));
  }

  setMappings(list: Mapping[], notify = true): void {
    this.mappings = list
      .filter((m) => m && typeof m.target === "string" && m.target && m.channel >= 1 && m.channel <= 16 && m.number >= 0 && m.number < 128)
      .map((m) => ({ source: m.source === "note" || m.source === "program" ? m.source : "cc", channel: m.channel | 0, number: m.number | 0, target: m.target }));
    this.pickedUp.clear();
    if (notify) this.onMappingsChanged(this.getMappings());
  }

  removeTarget(target: string): void {
    this.setMappings(this.mappings.filter((m) => m.target !== target));
  }

  /** The list for the page: [{ source, channel, number, target, name }]. */
  describe() {
    return this.mappings.map((m) => ({ ...m, name: describeSource(m) }));
  }

  /** One MIDI message (Web MIDI's data). */
  receive(data: ArrayLike<number>): void {
    const event = parseMidi(data);
    if (!event || event.channel < 1 || event.channel > 16 || event.number < 0 || event.number > 127) return;
    const slot = (event.channel - 1) * 128 + event.number;
    this.eventCount++;
    this.lastEvent = describeSource(event);

    if (this.learning) {
      const learned: Mapping = { source: event.source, channel: event.channel, number: event.number, target: this.learning };
      this.learning = "";
      this.setMappings([...this.mappings.filter((m) => !sameSource(m, learned) && m.target !== learned.target), learned]);
      if (event.source === "cc") this.lastCc[slot] = event.value;
      this.onLearned(learned);
      return;
    }

    for (const m of this.mappings) if (sameSource(m, event)) this.apply(m, event, slot);
    if (event.source === "cc") {
      this.lastCc[slot] = event.value;
      this.ccSeen[slot] = 1;
    }
  }

  private apply(m: Mapping, event: MidiEvent, slot: number) {
    const previous = event.source === "cc" ? this.lastCc[slot]! : 0;
    const pressed = event.source !== "cc" || (event.value >= 64 && previous < 64);

    if (m.target.startsWith("action:")) {
      if (!pressed) return;
      const action = m.target.slice("action:".length);
      if (action === "preset.next") this.onPresetStep(1);
      else if (action === "preset.previous") this.onPresetStep(-1);
      else if (action === "mute") this.onMuteToggle();
      else if (action.startsWith("scene.")) this.onScene(action);
      else this.onAction(action);
      return;
    }
    if (!m.target.startsWith("param:")) return; // "daw:" belongs to MicFX DAW

    const id = m.target.slice("param:".length);
    const info = this.params.info[id];
    if (!info) return;
    const current = toNormalised(info, this.params.get(id));
    const set = (normalised: number) => this.params.set(id, fromNormalised(info, Math.min(1, Math.max(0, normalised))));

    if (info.bool) {
      if (pressed) set(current > 0.5 ? 0 : 1);
      return;
    }
    if (info.choices) {
      const count = info.choices.length;
      if (count < 2) return;
      if (event.source === "cc") this.params.set(id, Math.round((event.value / 127) * (count - 1)));
      else this.params.set(id, (Math.round(this.params.get(id)) + 1) % count);
      return;
    }
    if (event.source !== "cc") {
      set(current < 0.5 ? 1 : 0); // a key flips a knob between its ends
      return;
    }

    // A knob picks up: it moves the value only once it reaches (or passes) it.
    const incoming = event.value / 127;
    let following = this.pickedUp.get(m.target) ?? false;
    if (following && Math.abs(current - (this.lastSet.get(m.target) ?? current)) > 0.01) following = false; // moved on screen since
    if (!following) {
      const before = previous / 127;
      following = Math.abs(incoming - current) < 0.03 || (this.ccSeen[slot] === 1 && (before - current) * (incoming - current) <= 0);
    }
    this.pickedUp.set(m.target, following);
    if (following) {
      set(incoming);
      this.lastSet.set(m.target, toNormalised(info, this.params.get(id)));
    }
  }
}

/** Listens to every MIDI input (and ones plugged in later). False when the browser has no Web MIDI or says no. */
export async function connectMidi(onMessage: (data: Uint8Array) => void): Promise<boolean> {
  const nav = navigator as Navigator & { requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccessLike> };
  if (!nav.requestMIDIAccess) return false;
  try {
    const access = await nav.requestMIDIAccess({ sysex: false });
    const attach = () => access.inputs.forEach((input) => (input.onmidimessage = (event) => event.data && onMessage(event.data)));
    attach();
    access.onstatechange = attach;
    return true;
  } catch {
    return false;
  }
}

// The parts of Web MIDI used here (the DOM lib's types vary between TypeScript versions).
interface MIDIAccessLike {
  inputs: { forEach(callback: (input: { onmidimessage: ((event: { data: Uint8Array | null }) => void) | null }) => void): void };
  onstatechange: (() => void) | null;
}

/** Whether MIDI was allowed before, so it can connect without asking again. */
export async function midiAlreadyAllowed(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "midi" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}
