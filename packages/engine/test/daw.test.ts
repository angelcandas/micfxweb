// daw.wasm (build-daw.sh) in Node: the desktop DAW, with its threads, behind DawHost's C API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface DawModule {
  ccall(name: string, ret: string | null, types: string[], args: unknown[]): number;
  _micfx_daw_dispatch(): number;
  _micfx_daw_tick(): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  wasmMemory: WebAssembly.Memory;
}

let m: DawModule;
const pending = new Map<number, (value: unknown) => void>();
const events: string[] = [];
const autoMixEvents: Record<string, unknown>[] = [];
const exportEvents: { progress?: number; done?: boolean; cancelled?: boolean; error?: string; files?: string[] }[] = [];
let nextId = 1;
let timers: ReturnType<typeof setInterval>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string, args: unknown[]): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    m.ccall("micfx_daw_call", null, ["number", "string", "string"], [id, name, JSON.stringify(args)]);
  });
const daw = (command: string, args: object = {}) => call("daw", [command, args]);

function writeFile(path: string, bytes: Uint8Array) {
  const at = m._malloc(bytes.length);
  new Uint8Array(m.wasmMemory.buffer).set(bytes, at);
  const ok = m.ccall("micfx_daw_write", "number", ["string", "number", "number"], [path, at, bytes.length]);
  m._free(at);
  return ok === 1;
}

beforeAll(async () => {
  const url = new URL("../dist/daw.mjs", import.meta.url).href;
  const { default: createDawModule } = await import(/* @vite-ignore */ url);
  m = await createDawModule({
    onDawComplete: (id: number, json: string) => { pending.get(id)?.(JSON.parse(json)); pending.delete(id); },
    onDawEvent: (name: string, json: string) => { events.push(name); if (name === "dawExport") exportEvents.push(JSON.parse(json)); if (name === "dawAutoMix") autoMixEvents.push(JSON.parse(json)); },
    onDawChooser: () => {},
    onDawClipboard: () => {},
    print: () => {},
    printErr: () => {},
  });
  m.ccall("micfx_daw_mount", "number", ["number"], [0]);
  m.ccall("micfx_daw_create", "number", ["number", "number"], [48000, 128]);
  timers = [setInterval(() => m._micfx_daw_dispatch(), 2), setInterval(() => m._micfx_daw_tick(), 33)];
}, 60_000);

afterAll(() => timers.forEach(clearInterval));

describe("daw.wasm", () => {
  it("answers the DAW screen's calls in DAW mode", async () => {
    await daw("mode", { daw: true });
    const session = await daw("session");
    expect(session.mode).toBe("daw");
    expect(session.tracks.length).toBeGreaterThan(0);
    const info = await call("getParameterInfo", []);
    expect(Object.keys(info).length).toBeGreaterThan(100);
  });

  it("imports a WAV and reads its audio", async () => {
    const wav = readFileSync(fileURLToPath(new URL("../../../apps/daw/e2e/voice.wav", import.meta.url)));
    expect(writeFile("/home/web/Music/voice.wav", wav)).toBe(true);
    const added = await daw("importFile", { file: "/home/web/Music/voice.wav" });
    expect(added.ok).toBe(true);
    expect(added.length).toBeCloseTo(2, 1);

    let peaks: number[] = [];
    for (let i = 0; i < 20 && peaks.length === 0; i++) {
      peaks = (await daw("peaks", { file: "/home/web/Music/voice.wav" }))?.peaks ?? [];
      if (!peaks.length) await new Promise((r) => setTimeout(r, 100));
    }
    // 16-bit WAVs decode (JUCE needs JUCE_LITTLE_ENDIAN on wasm).
    expect(Math.max(...peaks)).toBeGreaterThan(0.2);
  });

  it("saves a project file", async () => {
    const saved = await new Promise<unknown>((resolve) => {
      // "saveAs" asks the page for a folder: answer as the page would.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m as any).onDawChooser = (id: number) => m.ccall("micfx_daw_chooser_result", null, ["number", "string"], [id, "/home/web/Documents/Test Song"]);
      void daw("saveAs").then(resolve);
    });
    expect(saved).toMatchObject({ ok: true });
    expect((await daw("session")).project.name).toBe("Test Song");
    const list = (path: string) => {
      const listed = m.ccall("micfx_daw_list", "number", ["string"], [path]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = (JSON.parse((m as any).UTF8ToString(listed)) as { name: string }[]).map((e) => e.name);
      m._free(listed);
      return names;
    };
    expect(list("/home/web/Documents")).toContain("Test Song.micfx");
  });

  it("keeps the undo history and versions across a restart", async () => {
    const names = async () => ((await daw("session")).tracks as { name: string }[]).map((t) => t.name);
    // One click after another (the history follows the undo manager between them).
    const click = async (command: string, args: object = {}) => { await daw(command, args); await new Promise((r) => setTimeout(r, 30)); };
    await click("addTrack", { name: "Keep A" });
    await click("addTrack", { name: "Keep B" });
    await click("undo");
    expect(await names()).toContain("Keep A");
    expect(await names()).not.toContain("Keep B");
    const before = await call("webHistory", ["flush"]);
    expect(before.unsaved).toBe(true);
    expect(before.savedAt).toBeGreaterThan(0);

    // The tab closes (no clean shutdown) and comes back.
    m.ccall("micfx_daw_destroy", null, [], []);
    m.ccall("micfx_daw_create", "number", ["number", "number"], [48000, 128]);
    await daw("mode", { daw: true });
    let session = await daw("session");
    expect(session.project.name).toBe("Test Song");
    expect(session.project.recoverable || "").toBe("");
    expect(await names()).toContain("Keep A");
    expect(await names()).not.toContain("Keep B");
    expect(session.canUndo).toBe(true);
    expect(session.canRedo).toBe(true);

    await daw("redo");
    expect(await names()).toContain("Keep B");
    await daw("undo");
    await daw("undo");
    expect(await names()).not.toContain("Keep A");
    await daw("redo");
    session = await daw("session");
    expect(session.tracks.map((t: { name: string }) => t.name)).toContain("Keep A");

    // Saving makes a version; going back to it works.
    await daw("save");
    await new Promise((r) => setTimeout(r, 400));
    const history = await call("webHistory", []);
    const saved = history.versions.find((v: { saved: boolean }) => v.saved);
    expect(saved).toBeTruthy();
    await daw("addTrack", { name: "Later" });
    expect(await names()).toContain("Later");
    expect((await call("webHistory", ["restore", saved.id])).ok).toBe(true);
    expect(await names()).not.toContain("Later");
    expect(await names()).toContain("Keep A");
  });

  it("packs the project as a desktop project and unpacks it", async () => {
    const staged = await call("webProject", ["stage"]);
    expect(staged.ok).toBe(true);
    expect(staged.files).toContain("project.xml");
    expect(staged.files.some((f: string) => f.startsWith("Audio/") && f.endsWith(".wav"))).toBe(true);

    const packed = await call("webProject", ["pack"]);
    expect(packed.ok).toBe(true);
    expect(packed.path).toMatch(/Test Song\.micfxproj$/);
    const unpacked = await call("webProject", ["unpack", packed.path]);
    expect(unpacked.ok).toBe(true);
    expect(unpacked.folder).toBe("/home/web/Documents/MicFX Projects/Test Song.micfx");
    const listed = m.ccall("micfx_daw_list", "number", ["string"], [unpacked.folder]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (JSON.parse((m as any).UTF8ToString(listed)) as { name: string }[]).map((e) => e.name);
    m._free(listed);
    expect(names).toEqual(expect.arrayContaining(["project.xml", "Audio"]));
    expect(names).not.toContain("History");
    expect((await call("webProject", ["cleanup"])).ok).toBe(true);
  });

  it.each(["wav", "flac", "mp3"])("exports the mix as %s in the background, with progress", async (format) => {
    exportEvents.length = 0;
    const started = await daw("export", { kind: "mix", format, folder: "/home/web/Music/Exports", name: `Mix ${format}`, overwrite: true });
    expect(started.ok).toBe(true);
    for (let i = 0; i < 300 && !exportEvents.some((e) => e.done); i++) await new Promise((r) => setTimeout(r, 50));
    const done = exportEvents.find((e) => e.done)!;
    expect(done.error || "").toBe("");
    expect(done.files?.[0]).toBe(`/home/web/Music/Exports/Mix ${format}.${format}`);
    const size = m.ccall("micfx_daw_list", "number", ["string"], ["/home/web/Music/Exports"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (JSON.parse((m as any).UTF8ToString(size)) as { name: string; size: number }[]).find((e) => e.name === `Mix ${format}.${format}`);
    m._free(size);
    expect(entry?.size).toBeGreaterThan(format === "wav" ? 100_000 : 5_000);
  });

  it("cancels an export", async () => {
    exportEvents.length = 0;
    await daw("export", { kind: "mix", format: "wav", folder: "/home/web/Music/Exports", name: "Cancelled", overwrite: true });
    await daw("cancelExport");
    for (let i = 0; i < 300 && !exportEvents.some((e) => e.done); i++) await new Promise((r) => setTimeout(r, 50));
    expect(exportEvents.find((e) => e.done)).toBeTruthy();
  });

  it("listens to the tracks for Auto Mix on several threads", async () => {
    // A second track with the same voice, so there's more than one to listen to.
    await daw("importFile", { file: "/home/web/Music/voice.wav", track: -1 });
    autoMixEvents.length = 0;
    const started = await daw("autoMix", { action: "analyse" });
    expect(started).toMatchObject({ ok: true });
    for (let i = 0; i < 600 && !autoMixEvents.some((e) => e.state === "ready" || e.state === "error"); i++) await new Promise((r) => setTimeout(r, 50));
    const ready = autoMixEvents.find((e) => e.state === "ready" || e.state === "error")!;
    expect(ready.state).toBe("ready");
    expect(Array.isArray(ready.moves)).toBe(true);
    expect((ready.tracks as unknown[]).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("sends the session and status to the page", () => {
    expect(events).toContain("dawSession");
    expect(events).toContain("dawStatus");
  });
});
