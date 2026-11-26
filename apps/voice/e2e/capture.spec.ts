import { fileURLToPath } from "node:url";
import { devices, expect, test, type Page } from "@playwright/test";

// Capture (mobile plan, phase 1): open, tap, record; the take is safe as it's recorded.
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
test.use(phone);

const record = (page: Page) => page.getByRole("button", { name: /^(Record|Stop)$/ }).first();

async function ready(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/capture\.html/); // a phone opens on Capture
  await expect(record(page)).toBeVisible();
}

test("a phone opens on Capture, and one tap records an idea that is kept", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const box = await record(page).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(100);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height); // on the first screen

  await record(page).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark this moment" })).toBeVisible();
  await page.waitForTimeout(3000);
  expect(await page.getByRole("timer").textContent()).not.toBe("0:00.0");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Ideas/ }).click();
  const card = page.locator("article.idea");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Idea ·");
  // The audio is a real WAV of about three seconds.
  const seconds = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("ideas");
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
      if (!name.endsWith(".wav")) continue;
      const file = await handle.getFile();
      return (file.size - 44) / 2 / new DataView(await file.arrayBuffer()).getUint32(24, true);
    }
    return 0;
  });
  expect(seconds).toBeGreaterThan(2.5);
  expect(seconds).toBeLessThan(6);

  // Still there after a reload; rename and star it.
  await page.reload();
  await page.getByRole("tab", { name: /Ideas/ }).click();
  await expect(page.locator("article.idea")).toHaveCount(1);
  await page.getByRole("button", { name: /^More for/ }).click();
  await page.getByRole("button", { name: "Star", exact: true }).click();
  await expect(page.locator("article.idea")).toContainText("★");
  expect(errors).toEqual([]);
});

test("a take cut short by a crash is recovered", async ({ browser }) => {
  const context = await browser.newContext({ ...phone });
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  await ready(page);
  await record(page).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(2500);
  // The tab goes away without Stop (a crash, a call, a dead battery).
  const again = await context.newPage();
  await page.close({ runBeforeUnload: false });
  await again.goto("/capture.html#ideas");
  const card = again.locator("article.idea");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Recovered");
  await context.close();
});

test("the Live screen is still there, behind ?live", async ({ page }) => {
  await page.goto("/?live=1");
  await expect(page.locator(".recorder .record-button")).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture" })).toBeVisible();
});

test("the desktop keeps the Live screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).not.toHaveURL(/capture/);
  await context.close();
});

async function recordOne(page: Page, ms = 3500) {
  await record(page).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(ms);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText(/^Saved/).first()).toBeVisible();
}

test("an idea opens full screen: seek, loop, speed, notes, polish, layer and mix", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await recordOne(page);
  await page.getByRole("tab", { name: /Ideas/ }).click();
  await page.locator("article.idea .idea-name").click();
  const detail = page.locator("dialog.detail");
  await expect(detail).toBeVisible();

  await detail.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(600);
  await detail.getByRole("button", { name: "Pause" }).click();
  await detail.getByRole("button", { name: "0.5×" }).click();
  await detail.getByRole("button", { name: "Loop" }).click(); // start
  await detail.getByRole("button", { name: /set the end/ }).click(); // end
  await expect(detail.getByRole("button", { name: /^Loop 0:/ })).toBeVisible();
  await detail.getByRole("button", { name: /Mark here/ }).click();
  await detail.getByLabel("Note").fill("chorus idea in G");
  await detail.getByLabel("Note").blur();
  await detail.getByLabel("Tempo in BPM").fill("96");
  await detail.getByLabel("Tempo in BPM").blur();

  // The melody as notes.
  await detail.getByRole("button", { name: /Turn the melody into notes/ }).click();
  await expect(detail.getByRole("button", { name: "Save as MIDI" })).toBeVisible({ timeout: 30_000 });

  // A polished copy.
  await detail.getByRole("button", { name: /Make it sound good/ }).click();
  await expect(page.getByText("Saved a polished copy")).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("article.idea")).toHaveCount(2);
  await expect(page.locator("article.idea").first()).toContainText("polished");

  // A layer over the first idea, then the mix.
  await page.locator("article.idea", { hasText: "chorus idea in G", hasNotText: "polished" }).locator(".idea-name").click();
  await detail.getByRole("button", { name: /Layer another take/ }).click();
  await expect(page.getByText(/Layering over/)).toBeVisible();
  await recordOne(page, 2500);
  await page.getByRole("tab", { name: /Ideas/ }).click();
  await expect(page.locator("article.idea")).toHaveCount(3);
  await page.locator("article.idea", { hasText: "Layer / copy" }).first().locator(".idea-name").click();
  await detail.getByRole("button", { name: /Mix with the idea underneath/ }).click();
  await expect(page.getByText("Mixed into a new idea.")).toBeVisible({ timeout: 20_000 });
  await detail.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("article.idea")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("audio comes in from files, and ideas go out as files for a computer", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await ready(page);
  await recordOne(page, 2500);
  await page.getByRole("tab", { name: /Ideas/ }).click();
  // Add audio from a file (a voice memo, a bounce).
  await page.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL("./voice.wav", import.meta.url)));
  await expect(page.locator("article.idea")).toHaveCount(2, { timeout: 20_000 });
  // Select both, and save them for the computer: one .zip.
  await page.getByRole("button", { name: "Select" }).click();
  await expect(page.getByRole("button", { name: "Send to DAW" })).toHaveCount(0); // a phone has no room for it
  for (const box of await page.locator(".idea-check").all()) await box.check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save for the computer" }).click();
  expect((await download).suggestedFilename()).toMatch(/^MicFX ideas .*\.zip$/);
});

test("audio shared from another app lands in Ideas (the share target)", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload(); // now the service worker has the page
  const final = await page.evaluate(async () => {
    const wav = new Uint8Array(44 + 9600);
    const form = new FormData();
    form.append("audio", new File([wav], "memo.wav", { type: "audio/wav" }));
    return (await fetch("./share-target", { method: "POST", body: form })).url;
  });
  expect(final).toContain("capture.html?shared=1");
});
