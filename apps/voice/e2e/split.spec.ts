import { existsSync, readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { STEMS_MODEL } from "@micfx/engine/stems";
import { singingWav } from "./singing";
// The whole-song split runs first and alone, in a browser of its own (see playwright.config.ts).

// The stem splitter's weights (84 MB): CI keeps them in a cache and puts them where the app
// keeps them after a download; elsewhere the test is skipped.
const model = process.env.MICFX_STEMS_MODEL;

/**
 * Puts the weights in the browser's private files, where the app keeps them after a download
 * (a routed response this big closes the page, so they go across in 8 MB pieces).
 */
async function keepModel(page: Page, file: string) {
  const bytes = readFileSync(file);
  const piece = 8 << 20;
  const pieces = Math.ceil(bytes.length / piece);
  await page.route(/\/__model\/\d+$/, (route) => {
    const k = Number(route.request().url().split("/").pop());
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: bytes.subarray(k * piece, (k + 1) * piece) });
  });
  await page.evaluate(
    async ({ name, pieces }) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("models", { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      for (let k = 0; k < pieces; ++k) await writable.write(await (await fetch(`/__model/${k}`)).arrayBuffer());
      await writable.close();
    },
    { name: STEMS_MODEL.fileName, pieces },
  );
}

test("a whole song is split into its voice and backing, then practised", async ({ page }) => {
  test.skip(!model || !existsSync(model), "MICFX_STEMS_MODEL isn't set");
  test.setTimeout(330_000); // one Worker on CI's 4 cores: about 2 minutes for these 8 seconds
  const log: string[] = [];
  page.on("console", (m) => log.push(m.type() + ": " + m.text().slice(0, 300)));
  page.on("pageerror", (e) => log.push("pageerror: " + e.message.slice(0, 300)));
  await page.goto("/");
  await keepModel(page, model!);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();

  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-open").click();
  await (await choosing).setFiles({ name: "Whole song.wav", mimeType: "audio/wav", buffer: singingWav(8) });
  await expect(page.locator(".practice-overlay-info")).toContainText(/Loading|Taking the voice/, { timeout: 30_000 });
  // How long it takes, then how long it has left (plan point 18).
  await expect(page.locator(".web-split-time")).toHaveText(/^(Splitting takes (under a minute|about (a minute|\d+ min)) here|(under a minute|about (a minute|\d+ min)) left)$/);
  try {
    await expect(page.locator(".practice-song")).toHaveText("Whole song", { timeout: 240_000 });
  } catch (error) {
    console.log("Split never finished. Progress: " + (await page.locator(".practice-progress-text").allTextContents()).join(" | ") + "\nPage: " + (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500))) + "\n" + log.slice(-30).join("\n"));
    throw error;
  }
  await expect(page.locator(".tracks-rows .track")).toHaveCount(2);
});
