import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Practice on the web: a voice on its own is prepared (its melody found by analysis.wasm in
// a worker), kept in the browser's private files, and opens again from the library.

const RATE = 44100;

/** A sung melody: five notes of two seconds with pauses between, as a 16-bit WAV. */
function singingWav(seconds: number): Buffer {
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  const notes = [220, 247, 262, 196, 233];
  let phase = 0;
  for (let i = 0; i < frames; ++i) {
    const t = i / RATE;
    const inPhrase = t % 3.2;
    let voice = 0;
    if (inPhrase < 2) {
      const f = notes[Math.floor(t / 3.2) % notes.length]! * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, inPhrase / 0.05, (2 - inPhrase) / 0.1);
      for (let h = 1; h <= 12; ++h) voice += Math.sin(phase * h) / (h * (h > 3 ? 1.5 : 1));
      voice *= 0.25 * env;
    }
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(voice * 32767))), 44 + i * 2);
  }
  return data;
}

test("a voice-only song is prepared, drawn, and opens again from the library", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();
  const view = page.locator(".practice-bar");
  await expect(view).toBeVisible();

  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-voice").click();
  await (await choosing).setFiles({ name: "Scale study.wav", mimeType: "audio/wav", buffer: singingWav(16) });
  await expect(page.locator(".practice-song")).toHaveText("Scale study", { timeout: 30_000 });
  await expect(page.locator(".practice-message")).toContainText("Ready");
  await expect(page.locator(".practice-phrase").first()).toBeVisible();
  const phrases = await page.locator(".practice-phrase").count();
  expect(phrases).toBeGreaterThan(1);

  // Singing along (the fake mic): phrases are scored as they end.
  await page.locator('[data-transport="play"]').click();
  await expect(page.locator(".practice-pass-value")).not.toHaveText("–", { timeout: 15_000 });
  await page.locator('[data-transport="play"]').click();
  expect(errors).toEqual([]);

  // After a reload, the song is picked up again and is in the library.
  await page.reload();
  await expect(page.locator(".practice-song")).toHaveText("Scale study", { timeout: 15_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".practice-library")).toContainText("Scale study");
});

// The stem splitter's weights (84 MB): CI keeps them in a cache and serves them in place of
// the download; elsewhere the test is skipped.
const model = process.env.MICFX_STEMS_MODEL;

test("a whole song is split into its voice and backing, then practised", async ({ page }) => {
  test.skip(!model || !existsSync(model), "MICFX_STEMS_MODEL isn't set");
  test.setTimeout(300_000);
  await page.route(/huggingface\.co/, (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", body: readFileSync(model!) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();

  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-open").click();
  await (await choosing).setFiles({ name: "Whole song.wav", mimeType: "audio/wav", buffer: singingWav(12) });
  await expect(page.locator(".practice-progress-text")).toContainText(/Downloading|Loading|Taking the voice/, { timeout: 30_000 });
  await expect(page.locator(".practice-song")).toHaveText("Whole song", { timeout: 240_000 });
  await expect(page.locator(".tracks-rows .track")).toHaveCount(2);
});
