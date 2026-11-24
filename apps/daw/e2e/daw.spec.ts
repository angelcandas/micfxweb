import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const voice = fileURLToPath(new URL("./voice.wav", import.meta.url));
const mod = process.platform === "darwin" ? "Meta" : "Control";

interface Session { project?: { name?: string; open?: boolean }; tracks?: { name: string; clips: unknown[] }[] }

const session = (page: Page) =>
  page.evaluate(() => (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw.call("daw", ["session", {}])) as Promise<Session>;

async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-title")).toHaveText("MicFX DAW");
  await expect(page.getByText("Arm a track and press")).toBeVisible({ timeout: 20_000 });
}

test("the desktop DAW screen runs on the web engine", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  // Live mode is MicFX Voice's: no switch here.
  await expect(page.locator(".topbar .mode-switch")).toBeHidden();
  const s = await session(page);
  expect(s.tracks?.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("imports a file from the computer and plays it", async ({ page }) => {
  await open(page);
  await page.mouse.click(900, 450); // a click starts the sound
  await page.keyboard.press(`${mod}+i`);
  const dialog = page.getByRole("dialog", { name: "Import audio" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "From your computer…" }).click();
  await (await chooser).setFiles(voice);
  await expect.poll(async () => (await session(page)).tracks?.some((t) => t.clips.length > 0), { timeout: 15_000 }).toBe(true);
  await expect(page.locator(".clip").first()).toBeVisible();
  // Its audio decoded (not silence).
  await expect.poll(async () => page.evaluate(async () => {
    const engine = (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw;
    const s = (await engine.call("daw", ["session", {}])) as { tracks: { clips: { file: string }[] }[] };
    const clip = s.tracks.flatMap((t) => t.clips)[0]!;
    const peaks = (await engine.call("daw", ["peaks", { file: clip.file }])) as { peaks?: number[] } | null;
    return Math.max(0, ...(peaks?.peaks ?? []));
  }), { timeout: 10_000 }).toBeGreaterThan(0.2);

  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  const status = await page.evaluate(() => {
    const engine = (window as unknown as { micfxDaw: { underruns: number; load: number; context: AudioContext } }).micfxDaw;
    return { state: engine.context.state, load: engine.load };
  });
  expect(status.state).toBe("running");
  expect(status.load).toBeLessThan(0.8);

  // Export renders on a background thread and the file is downloaded.
  await page.keyboard.press("Space");
  await page.keyboard.press(`${mod}+Shift+r`);
  const downloading = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator(".export-go").click();
  expect((await downloading).suggestedFilename()).toMatch(/\.wav$/);
});

test("saves a project in the browser and opens it after a reload", async ({ page }) => {
  await open(page);
  // A project is always open on the web (it autosaves): Save as names it.
  await page.keyboard.press(`${mod}+Shift+s`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("Web Song");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await session(page)).project?.name, { timeout: 10_000 }).toBe("Web Song");

  await page.reload();
  await expect(page.getByText("Arm a track and press")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press(`${mod}+o`);
  const openDialog = page.getByRole("dialog");
  await expect(openDialog.getByRole("option", { name: /Web Song/ })).toBeVisible();
  await openDialog.getByRole("option", { name: /Web Song/ }).click();
  await openDialog.getByRole("button", { name: "Open" }).click();
  await expect.poll(async () => (await session(page)).project?.name, { timeout: 10_000 }).toBe("Web Song");
});

test("keeps the work and its undo history across a reload, with versions to go back to", async ({ page }) => {
  await open(page);
  const call = (name: string, args: unknown[]) =>
    page.evaluate(([n, a]) => (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw.call(n as string, a as unknown[]), [name, args] as const);
  const names = async () => ((await session(page)).tracks ?? []).map((t) => t.name);
  await call("daw", ["addTrack", { name: "Guitar" }]);
  await expect(page.locator(".web-saved")).toHaveText(/Saved/, { timeout: 10_000 });

  await page.reload();
  await expect(page.getByText("Arm a track and press")).toBeVisible({ timeout: 20_000 });
  expect(await names()).toContain("Guitar");
  // The undo button still takes the step back.
  await expect.poll(async () => ((await session(page)) as { canUndo?: boolean }).canUndo).toBe(true);
  await page.mouse.click(900, 450);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(names).not.toContain("Guitar");
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(names).toContain("Guitar");

  // Saving keeps a version; going back to it from the Versions dialog.
  await page.keyboard.press(`${mod}+s`);
  await call("daw", ["addTrack", { name: "Bass" }]);
  await expect.poll(names).toContain("Bass");
  await page.locator(".web-saved").click();
  await page.getByRole("menuitem", { name: /Versions/ }).click();
  const dialog = page.getByRole("dialog", { name: "Versions" });
  await expect(dialog.getByRole("option", { name: /Saved/ }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/versions-dialog.png" });
  await dialog.getByRole("option", { name: /Saved/ }).first().click();
  await dialog.getByRole("button", { name: "Go back to this version" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(names).not.toContain("Bass");
  expect(await names()).toContain("Guitar");
});

test("takes a project to the computer as a .micfxproj and opens one", async ({ page }) => {
  await open(page);
  const call = (name: string, args: unknown[]) =>
    page.evaluate(([n, a]) => (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw.call(n as string, a as unknown[]), [name, args] as const);
  await call("daw", ["addTrack", { name: "Strings" }]);
  await expect(page.locator(".web-saved")).toHaveText(/Saved/, { timeout: 10_000 });

  await page.locator(".web-saved").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.screenshot({ path: "test-results/project-menu.png" });
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /Download project/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("My Song.micfxproj");
  const bundle = await download.path();

  // The downloaded one opened from the computer (a copy next to this one).
  await page.keyboard.press(`${mod}+o`);
  const dialog = page.getByRole("dialog", { name: "Open project" });
  await expect(dialog.getByRole("button", { name: "Project folder…" })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: ".micfxproj file…" }).click();
  await (await chooser).setFiles({ name: "Shared Song.micfxproj", mimeType: "application/zip", buffer: (await import("node:fs")).readFileSync(bundle) });
  await expect.poll(async () => (await session(page)).project?.name, { timeout: 10_000 }).toBe("My Song 2");
  expect(((await session(page)).tracks ?? []).map((t) => t.name)).toContain("Strings");
});

test("opens a desktop project folder from the computer", async ({ page }, info) => {
  const { mkdirSync, writeFileSync, copyFileSync } = await import("node:fs");
  const folder = info.outputPath("Desk Song.micfx");
  mkdirSync(`${folder}/Audio`, { recursive: true });
  copyFileSync(voice, `${folder}/Audio/voice.wav`);
  writeFileSync(`${folder}/project.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<PROJECT version="1" tempo="120.0"><TRACK id="5" name="Desk Track" volume="0.0"><CLIP id="6" file="Audio/voice.wav" start="0.0" offset="0.0" length="2.0"/></TRACK></PROJECT>`);

  await open(page);
  await page.keyboard.press(`${mod}+o`);
  const dialog = page.getByRole("dialog", { name: "Open project" });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Project folder…" }).click();
  await (await chooser).setFiles(folder);
  await expect.poll(async () => (await session(page)).project?.name, { timeout: 10_000 }).toBe("Desk Song");
  const tracks = (await session(page)).tracks ?? [];
  expect(tracks.map((t) => t.name)).toContain("Desk Track");
  expect(tracks.find((t) => t.name === "Desk Track")?.clips.length).toBe(1);
});

test("plays from MIDI: learn a pedal for play, and send MIDI clock", async ({ page }) => {
  // A stand-in Web MIDI keyboard and clock receiver (headless Chromium has no devices).
  await page.addInitScript(() => {
    const sent: number[][] = [];
    const input = { id: "in1", name: "Test Keys", type: "input", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    const output = { id: "out1", name: "Test Sync", type: "output", state: "connected", send: (data: number[]) => sent.push([...data]) };
    const access = { inputs: new Map([["in1", input]]), outputs: new Map([["out1", output]]), addEventListener() {} };
    Object.assign(window, { midiSent: sent, midiIn: input });
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => access });
  });
  await open(page);
  const send = (bytes: number[]) => page.evaluate((b) => (window as unknown as { midiIn: { onmidimessage(e: { data: Uint8Array }): void } }).midiIn.onmidimessage({ data: new Uint8Array(b) }), bytes);
  const sent = () => page.evaluate(() => (window as unknown as { midiSent: number[][] }).midiSent.map((m) => m[0]));

  // The clock goes to the output picked in MIDI devices.
  await page.locator(".web-saved").click();
  await page.getByRole("menuitem", { name: /MIDI devices/ }).click();
  const dialog = page.getByRole("dialog", { name: "MIDI devices" });
  await expect(dialog.getByText("Test Keys")).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Test Sync/ }).check();
  await page.screenshot({ path: "test-results/midi-devices.png" });
  await dialog.getByRole("button", { name: "Done" }).click();

  // MIDI learn (as the MIDI button does): a pedal (CC 64) for Play.
  await page.mouse.click(900, 450); // a click starts the sound
  await page.evaluate(() => (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw.call("midi", ["learn", { target: "daw:play" }]));
  await send([0xb0, 64, 127]);
  await expect.poll(async () => JSON.stringify((await page.evaluate(() => (window as unknown as { micfxDaw: { call(n: string, a: unknown[]): Promise<unknown> } }).micfxDaw.call("midi", ["list"])) as { mappings: unknown }).mappings))
    .toContain("daw:play");
  await send([0xb0, 64, 0]);
  await send([0xb0, 64, 127]); // the pedal again: Play
  await expect.poll(sent, { timeout: 5_000 }).toContain(0xf8);
  expect((await sent()).some((m) => m === 0xfa || m === 0xfb)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(sent).toContain(0xfc);
});
