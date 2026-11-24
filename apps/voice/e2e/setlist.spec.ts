import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// The setlist on the web: songs kept in the browser, saved and opened as .micfxset files.

test("songs keep their sound, load with the keys, and come back after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const toggle = page.locator(".setlist-button");
  await expect(toggle).toBeVisible();
  await toggle.click();
  const drawer = page.locator(".setlist-drawer");
  const robot = page.locator('.effect-item[data-learn="param:robotOn"]');

  await drawer.getByRole("button", { name: "+ Add the current sound as a song" }).click();
  await expect(drawer.locator(".setlist-song-name")).toHaveCount(1);
  await drawer.locator(".setlist-input").first().fill("Opener");
  await drawer.locator(".setlist-input").first().press("Enter");
  await drawer.locator(".setlist-lyrics").fill("First line\nSecond line");
  await drawer.locator(".setlist-lyrics").blur();

  await robot.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await drawer.getByRole("button", { name: "+ Add the current sound as a song" }).click();
  await drawer.locator(".setlist-input").first().fill("Robot song");
  await drawer.locator(".setlist-input").first().press("Enter");
  await expect(drawer.locator(".setlist-song-name")).toHaveText([/^Opener/, /^Robot song/]);

  // Page Up / Page Down step through the show (outside the text boxes).
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("PageUp");
  await expect(robot).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("PageDown");
  await expect(robot).toHaveAttribute("aria-pressed", "true");

  await page.waitForTimeout(500);
  await page.reload();
  await page.locator(".setlist-button").click();
  await expect(page.locator(".setlist-drawer .setlist-song-name")).toHaveText([/^Opener/, /^Robot song/]);
  await expect(page.locator(".setlist-song.is-current")).toContainText("Robot song");
  await page.locator(".setlist-drawer .setlist-song-name", { hasText: "Opener" }).click();
  await expect(page.locator(".setlist-drawer .setlist-lyrics")).toHaveValue("First line\nSecond line");
  await expect(robot).toHaveAttribute("aria-pressed", "false");
});

test("a setlist saves as a .micfxset file and opens again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".setlist-button").click();
  const drawer = page.locator(".setlist-drawer");
  await drawer.getByRole("button", { name: "+ Add the current sound as a song" }).click();
  await drawer.locator(".setlist-input").first().fill('Encore "live" & loud');
  await drawer.locator(".setlist-input").first().press("Enter");
  await expect(drawer.locator(".setlist-dirty")).toHaveText("•");

  const downloading = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("New setlist.micfxset");
  const xml = await readFile((await download.path())!, "utf8");
  expect(xml).toContain('<SONG name="Encore &quot;live&quot; &amp; loud"');
  await expect(drawer.locator(".setlist-dirty")).toHaveText("");

  // Opening a file from the desktop app (its backing track is on that computer).
  await drawer.getByRole("button", { name: "New" }).click(); // saved: no second press needed
  await expect(drawer.locator(".setlist-song-name")).toHaveCount(0);
  const desktop = xml.replace('backing=""', 'backing="C:\\Music\\Encore.wav" key="9" minor="1"');
  const choosing = page.waitForEvent("filechooser");
  await drawer.getByRole("button", { name: "Open…" }).click();
  await (await choosing).setFiles({ name: "Tour.micfxset", mimeType: "application/xml", buffer: Buffer.from(desktop) });
  await expect(drawer.locator(".setlist-title")).toHaveText("Tour");
  await expect(drawer.locator(".setlist-song-name")).toHaveText([/Encore "live" & loud.*Am/]);
  await drawer.locator(".setlist-song-name").click();
  await expect(page.locator(".record-status")).toContainText("pick Encore.wav again");
});
