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
});

test("saves a project in the browser and opens it after a reload", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${mod}+s`);
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
