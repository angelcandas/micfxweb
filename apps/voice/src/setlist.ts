// The setlist on the web: the desktop's Setlist (src/Setlist.cpp). The songs of a show, in
// order, each with its sound (every setting but the input gain), effect order, scenes, tempo
// (for the looper), key (for the autotune), backing track, lyrics and notes. Loading a song
// puts all of that in place at once.
//
// Kept in this browser (the list in localStorage, the songs' backing tracks in IndexedDB).
// Save downloads a .micfxset file in the desktop's format, and Open reads one; a backing track
// from another computer is picked again with Choose….
import type { LooperState } from "@micfx/engine";
import type { ParameterAccess, SavedScenes } from "./live-state";

export interface Song {
  name: string;
  /** Real values, input gain left out. */
  sound: Record<string, number>;
  /** Module keys joined by ",", or "" (the standard order). */
  order: string;
  /** BPM for the looper, 0 for none. */
  tempo: number;
  /** -1 (none) .. 11, C = 0. */
  key: number;
  minor: boolean;
  /** The backing track's file name, as shown. */
  backing: string;
  /** Where its audio is kept in this browser, when it is. */
  backingId: string;
  lyrics: string;
  notes: string;
  scenes: SavedScenes;
}

export interface SavedSetlist {
  name: string;
  dirty: boolean;
  current: number;
  songs: Song[];
}

/** The song files kept in the browser, by id. */
export interface SongFiles {
  put(id: string, file: Blob): Promise<void>;
  get(id: string): Promise<Blob | undefined>;
  /** Drops every file whose id isn't in `keep`. */
  prune(keep: Set<string>): Promise<void>;
}

/** What the setlist works on. */
export interface SetlistHost {
  params: ParameterAccess;
  getOrder(): string;
  setOrder(order: string): void;
  scenes: { save(): SavedScenes; restore(saved: SavedScenes | undefined): void };
  looper(): LooperState;
  looperStop(): void;
  /** Sets the looper's tempo and locks it. */
  looperTempo(bpm: number): void;
  /** The backing track playing now (the first track that isn't a take). */
  currentBacking(): { name: string; file: Blob } | undefined;
  /** The song's backing track (or none) takes the place of the last song's. */
  replaceBacking(file: (Blob & { name: string }) | undefined): Promise<void>;
  files: SongFiles;
  /** The setlist changed (to keep it). */
  persist(saved: SavedSetlist): void;
  /** Labels the next undo step. */
  label?(name: string): void;
}

const MAX_NAME = 60;
const FIELDS = ["name", "key", "minor", "tempo", "backing", "lyrics", "notes"] as const;

export class Setlist {
  name = "New setlist";
  dirty = false;
  private songs: Song[] = [];
  private current = -1;

  constructor(private readonly host: SetlistHost) {}

  get size(): number {
    return this.songs.length;
  }

  getCurrent(): number {
    return this.current >= 0 && this.current < this.songs.length ? this.current : -1;
  }

  song(index: number): Song | undefined {
    return this.songs[index];
  }

  restore(saved: Partial<SavedSetlist> | null | undefined): void {
    if (!saved || !Array.isArray(saved.songs)) return;
    this.songs = saved.songs.map(cleanSong);
    this.name = typeof saved.name === "string" && saved.name ? saved.name : "New setlist";
    this.dirty = Boolean(saved.dirty);
    this.current = typeof saved.current === "number" ? saved.current : -1;
  }

  save(): SavedSetlist {
    return { name: this.name, dirty: this.dirty, current: this.getCurrent(), songs: this.songs };
  }

  /** { name, file, dirty, current, songs: [...] }, as the desktop's describe(). */
  describe() {
    return {
      name: this.name,
      file: "",
      dirty: this.dirty,
      current: this.getCurrent(),
      songs: this.songs.map((s) => ({
        name: s.name,
        key: s.key,
        minor: s.minor,
        tempo: s.tempo,
        backing: s.backing,
        lyrics: s.lyrics,
        notes: s.notes,
        scenes: s.scenes.scenes.map((scene) => scene.name),
      })),
    };
  }

  //==============================================================================
  /** Adds a song with the sound, scenes, looper tempo and backing track there are now. */
  async add(name = ""): Promise<number> {
    const backing = await this.keepBacking();
    const fallback = backing.backing ? backing.backing.replace(/\.[^.]+$/, "") : `Song ${this.songs.length + 1}`;
    this.songs.push({
      ...this.capture(),
      name: name.trim().slice(0, MAX_NAME) || fallback,
      ...backing,
      key: -1,
      minor: false,
      lyrics: "",
      notes: "",
    });
    this.current = this.songs.length - 1;
    this.changed();
    return this.current;
  }

  /** The sound and scenes there are now replace the song's. */
  async update(index: number): Promise<void> {
    const song = this.songs[index];
    if (!song) return;
    const now = this.capture();
    song.sound = now.sound;
    song.order = now.order;
    song.scenes = now.scenes;
    const looper = this.host.looper();
    if (looper.locked) song.tempo = looper.bpm;
    const backing = await this.keepBacking();
    if (backing.backing) Object.assign(song, backing);
    this.changed();
  }

  remove(index: number): void {
    if (!this.songs[index]) return;
    const now = this.getCurrent();
    this.songs.splice(index, 1);
    this.current = now === index ? -1 : now > index ? now - 1 : now;
    this.changed();
  }

  move(index: number, to: number): void {
    if (!this.songs[index]) return;
    const target = Math.max(0, Math.min(this.songs.length - 1, Math.round(to)));
    const loaded = this.songs[this.getCurrent()];
    const [song] = this.songs.splice(index, 1);
    this.songs.splice(target, 0, song!);
    this.current = loaded ? this.songs.indexOf(loaded) : -1;
    this.changed();
  }

  /** Any of { name, key, minor, tempo, backing, lyrics, notes }. */
  setInfo(index: number, fields: Record<string, unknown>): void {
    const song = this.songs[index];
    if (!song) return;
    const has = (key: (typeof FIELDS)[number]) => key in fields && fields[key] !== undefined;
    if (has("name") && String(fields.name).trim()) song.name = String(fields.name).trim().slice(0, MAX_NAME);
    if (has("key")) song.key = clamp(Math.round(Number(fields.key) || 0), -1, 11);
    if (has("minor")) song.minor = Boolean(fields.minor);
    if (has("tempo")) song.tempo = clamp(Number(fields.tempo) || 0, 0, 300);
    if (has("backing")) {
      song.backing = String(fields.backing);
      song.backingId = typeof fields.backingId === "string" ? fields.backingId : "";
    }
    if (has("lyrics")) song.lyrics = String(fields.lyrics).slice(0, 100000);
    if (has("notes")) song.notes = String(fields.notes).slice(0, 20000);
    this.changed();
  }

  /** A file picked as the song's backing track: kept in the browser with it. */
  async setBacking(index: number, file: Blob & { name: string }): Promise<void> {
    if (!this.songs[index]) return;
    const backingId = fileId(file.name, file);
    await this.host.files.put(backingId, file);
    this.setInfo(index, { backing: file.name, backingId });
  }

  /**
   * Puts the song in place. False if there is no such song; a backing track that isn't
   * in this browser comes back as a warning.
   */
  async load(index: number): Promise<{ ok: boolean; warning: string }> {
    const song = this.songs[index];
    if (!song) return { ok: false, warning: "" };
    this.host.label?.(`Load song ${song.name}`);

    // Its scenes first: a glide still running finishes before the song's sound lands.
    this.host.scenes.restore(song.scenes);

    // The last song's loop stops (its layers stay, for Play or Clear).
    const looper = this.host.looper();
    if (looper.state === "playing" || looper.state === "overdubbing") this.host.looperStop();

    // The sound, at once (a song change isn't a glide).
    const { params } = this.host;
    for (const [id, value] of Object.entries(song.sound)) {
      if (id === "inputGain" || !params.info[id] || !Number.isFinite(value)) continue;
      if (Math.abs(params.get(id) - value) > 1e-6) params.set(id, value);
    }
    this.host.setOrder(song.order);

    // Its key pulls the autotune (a major or minor scale follows the song's mode).
    if (song.key >= 0) {
      if (params.info.tuneKey) params.set("tuneKey", song.key);
      if (params.info.tuneScale) {
        const scale = Math.round(params.get("tuneScale"));
        if (scale === 1 || scale === 2) params.set("tuneScale", song.minor ? 2 : 1);
      }
    }
    if (song.tempo > 0) this.host.looperTempo(song.tempo);

    // The backing track: the last song's makes way for this one's.
    let warning = "";
    const file = song.backingId ? await this.host.files.get(song.backingId) : undefined;
    if (song.backing && !file) warning = `The backing track isn't in this browser: pick ${song.backing} again with Choose….`;
    await this.host.replaceBacking(file ? new File([file], song.backing, { type: file.type }) : undefined);

    this.current = index;
    this.host.persist(this.save());
    return { ok: true, warning };
  }

  /** The next or previous song; no wrap (the show has an end). */
  async step(delta: number): Promise<{ ok: boolean; warning: string }> {
    if (!this.songs.length) return { ok: false, warning: "" };
    const now = this.getCurrent();
    const next = now < 0 ? (delta > 0 ? 0 : this.songs.length - 1) : now + delta;
    return next >= 0 && next < this.songs.length ? this.load(next) : { ok: false, warning: "" };
  }

  clear(): void {
    this.songs = [];
    this.current = -1;
    this.name = "New setlist";
    this.dirty = false;
    this.changed(false);
  }

  //==============================================================================
  /** The setlist as a .micfxset file (the desktop's XML). Marks it saved. */
  toFile(): string {
    this.dirty = false;
    this.changed(false);
    return toXml(this.songs);
  }

  /** Reads a .micfxset file. Returns an error message, or "". */
  open(text: string, fileName: string): string {
    const songs = fromXml(text);
    if (!songs) return `${fileName} isn't a MicFX setlist.`;
    this.songs = songs;
    this.current = -1;
    this.name = fileName.replace(/\.micfxset$/i, "") || "Setlist";
    this.dirty = false;
    this.changed(false);
    return "";
  }

  //==============================================================================
  private capture(): Pick<Song, "sound" | "order" | "tempo" | "scenes"> {
    const { params } = this.host;
    const looper = this.host.looper();
    return {
      sound: Object.fromEntries(params.ids.filter((id) => id !== "inputGain").map((id) => [id, round6(params.get(id))])),
      order: this.host.getOrder(),
      tempo: looper.locked ? looper.bpm : 0,
      scenes: this.host.scenes.save(),
    };
  }

  /** The backing track playing now, kept with the songs. */
  private async keepBacking(): Promise<Pick<Song, "backing" | "backingId">> {
    const current = this.host.currentBacking();
    if (!current) return { backing: "", backingId: "" };
    const backingId = fileId(current.name, current.file);
    await this.host.files.put(backingId, current.file);
    return { backing: current.name, backingId };
  }

  private changed(dirty = true) {
    if (dirty) this.dirty = true;
    this.host.persist(this.save());
    void this.host.files.prune(new Set(this.songs.map((s) => s.backingId).filter(Boolean)));
  }
}

//==============================================================================
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round6 = (value: number) => Number(value.toFixed(6));

/** The same file gets the same id, so songs that share a backing track share its copy. */
export function fileId(name: string, file: Blob): string {
  return `${name}|${file.size}`;
}

function cleanSong(raw: Partial<Song>): Song {
  return {
    name: String(raw.name ?? "Song").slice(0, MAX_NAME),
    sound: typeof raw.sound === "object" && raw.sound ? { ...raw.sound } : {},
    order: String(raw.order ?? ""),
    tempo: clamp(Number(raw.tempo) || 0, 0, 300),
    key: clamp(Math.round(Number(raw.key ?? -1)), -1, 11),
    minor: Boolean(raw.minor),
    backing: String(raw.backing ?? ""),
    backingId: String(raw.backingId ?? ""),
    lyrics: String(raw.lyrics ?? ""),
    notes: String(raw.notes ?? ""),
    scenes: cleanScenes(raw.scenes),
  };
}

function cleanScenes(raw: Partial<SavedScenes> | undefined): SavedScenes {
  return {
    scenes: Array.isArray(raw?.scenes) ? raw.scenes.map((s) => ({ name: String(s.name ?? "Scene"), values: { ...(s.values ?? {}) } })) : [],
    active: typeof raw?.active === "number" ? raw.active : -1,
    glide: typeof raw?.glide === "number" ? raw.glide : 0.5,
  };
}

// "id=value;id=value", as the desktop writes sounds and scenes.
const pairs = (values: Record<string, number>) =>
  Object.entries(values)
    .map(([id, value]) => `${id}=${round6(value)}`)
    .join(";");

function parsePairs(text: string | null): Record<string, number> {
  const result: Record<string, number> = {};
  for (const pair of (text ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const value = parseFloat(pair.slice(at + 1));
    result[pair.slice(0, at)] = Number.isFinite(value) ? value : 0;
  }
  return result;
}

/** An XML attribute value, escaped as JUCE does (line breaks too). */
function attr(value: string | number | boolean): string {
  return String(value).replace(/[&<>"\n\r\t]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;" })[c]!);
}

export function toXml(songs: Song[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "", "<SETLIST>"];
  for (const s of songs) {
    const fields: [string, string | number | boolean][] = [["name", s.name], ["sound", pairs(s.sound)]];
    if (s.order) fields.push(["order", s.order]);
    fields.push(["tempo", s.tempo], ["backing", s.backing]);
    if (s.key >= 0) fields.push(["key", s.key], ["minor", s.minor ? 1 : 0]);
    if (s.lyrics) fields.push(["lyrics", s.lyrics]);
    if (s.notes) fields.push(["notes", s.notes]);
    lines.push(`  <SONG ${fields.map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}>`);
    lines.push(`    <SCENES active="${s.scenes.active}" glide="${s.scenes.glide}"${s.scenes.scenes.length ? ">" : "/>"}`);
    for (const scene of s.scenes.scenes) lines.push(`      <SCENE name="${attr(scene.name)}" values="${attr(pairs(scene.values))}"/>`);
    if (s.scenes.scenes.length) lines.push("    </SCENES>");
    lines.push("  </SONG>");
  }
  lines.push("</SETLIST>", "");
  return lines.join("\n");
}

/** The songs of a .micfxset file, or undefined when it isn't one. */
export function fromXml(text: string): Song[] | undefined {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return undefined;
  }
  const root = doc.documentElement;
  if (!root || root.nodeName !== "SETLIST" || doc.getElementsByTagName("parsererror").length) return undefined;
  return Array.from(root.children)
    .filter((e) => e.nodeName === "SONG")
    .map((e) => {
      const scenesNode = Array.from(e.children).find((c) => c.nodeName === "SCENES");
      const backing = e.getAttribute("backing") ?? "";
      return cleanSong({
        name: e.getAttribute("name") ?? "Song",
        sound: parsePairs(e.getAttribute("sound")),
        order: e.getAttribute("order") ?? "",
        tempo: Number(e.getAttribute("tempo") ?? 0),
        key: Number(e.getAttribute("key") ?? -1),
        minor: ["1", "true"].includes(e.getAttribute("minor") ?? ""),
        // A path from the desktop: its file name, picked again here.
        backing: backing.split(/[\\/]/).pop() ?? "",
        backingId: "",
        lyrics: e.getAttribute("lyrics") ?? "",
        notes: e.getAttribute("notes") ?? "",
        scenes: {
          scenes: Array.from(scenesNode?.children ?? [])
            .filter((c) => c.nodeName === "SCENE")
            .map((c) => ({ name: c.getAttribute("name") ?? "Scene", values: parsePairs(c.getAttribute("values")) })),
          active: Number(scenesNode?.getAttribute("active") ?? -1),
          glide: Number(scenesNode?.getAttribute("glide") ?? 0.5),
        },
      });
    });
}
