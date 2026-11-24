import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The web's own Settings: a sound shared as a link, everything backed up to one file and
// restored, and what the browser keeps (plan section 9, points 4 to 6).

/** 3 s of a tone as a 16-bit WAV. */
function tone(): Buffer {
  const rate = 22050;
  const frames = rate * 3;
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; ++i) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 330 * i) / rate)), 44 + i * 2);
  return data;
}

async function openSettings(page: Page) {
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".settings-window .web-storage")).toBeVisible();
}

test("a sound opens from its link in another browser", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Robot$/ }).click();
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");

  await openSettings(page);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.locator(".web-share .setup-value")).toHaveText(/Copied/);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#sound=[A-Za-z0-9_-]+$/);
  await context.close();

  // Someone else (a fresh browser) opens it.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.goto(link);
  await theirs.getByRole("button", { name: "Done" }).click();
  await expect(theirs.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
  await expect(theirs.locator(".web-toast")).toHaveText("Opened a shared sound.");
  expect(new URL(theirs.url()).hash).toBe("");
  // It's their session now: still there after a reload.
  await theirs.reload();
  await expect(theirs.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
  await other.close();
});

test("everything is backed up to one file and restored in a fresh browser", async ({ browser }) => {
  const errors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();

  // Something to keep: a sound, a backing track, and a Practice song's files.
  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Robot$/ }).click();
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".add-track").first().click();
  await (await chooser).setFiles({ name: "Tone.wav", mimeType: "audio/wav", buffer: tone() });
  await expect(page.locator(".tracks-rows .track")).toHaveCount(1);
  await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("practice", { create: true })).getDirectoryHandle("abc123", { create: true });
    const w = await (await dir.getFileHandle("info.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ name: "Kept song", seconds: 3 }));
    await w.close();
  });

  // The storage list shows them, with sizes.
  await openSettings(page);
  const list = page.locator(".web-storage-list");
  await expect(list.locator('[data-kind="track"] .web-storage-name')).toHaveText("Tone");
  await expect(list.locator('[data-kind="practice"] .web-storage-name')).toHaveText("Kept song");
  await expect(list.locator('[data-kind="settings"]')).toBeVisible();
  await expect(page.locator(".web-storage .setup-value")).toContainText("used");

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Back up…" }).click();
  const backup = await downloading;
  expect(backup.suggestedFilename()).toMatch(/^MicFX Voice backup \d{4}-\d\d-\d\d\.micfxbackup$/);
  const file = readFileSync((await backup.path())!);
  expect(file.subarray(0, 4).toString("binary")).toBe("PK\x03\x04");
  await context.close();

  // A new computer: nothing kept, then the backup.
  const fresh = await browser.newContext();
  const again = await fresh.newPage();
  again.on("pageerror", (error) => errors.push(error.message));
  await again.goto("/");
  await again.getByRole("button", { name: "Done" }).click();
  await expect(again.locator(".tracks-rows .track")).toHaveCount(0);
  await openSettings(again);
  again.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("1 tracks and takes, 1 Practice songs");
    void dialog.accept();
  });
  const picking = again.waitForEvent("filechooser");
  await again.getByRole("button", { name: "Restore…" }).click();
  await (await picking).setFiles({ name: "backup.micfxbackup", mimeType: "application/zip", buffer: file });
  await again.waitForEvent("load");
  await expect(again.locator(".tracks-rows .track .track-name")).toHaveText("Tone");
  await expect(again.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");

  // Deleting from the storage list.
  await openSettings(again);
  await expect(again.locator('.web-storage-list [data-kind="practice"] .web-storage-name')).toHaveText("Kept song");
  again.once("dialog", (dialog) => void dialog.accept());
  await again.locator('.web-storage-list [data-kind="track"] .web-storage-delete').click();
  await expect(again.locator('.web-storage-list [data-kind="track"]')).toHaveCount(0);
  await expect(again.locator(".tracks-rows .track")).toHaveCount(0);
  expect(errors).toEqual([]);
  await fresh.close();
});
