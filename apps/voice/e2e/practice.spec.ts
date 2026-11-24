import { existsSync, readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { STEMS_MODEL } from "@micfx/engine/stems";

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

  // Lyrics: pasted, placed on the voice, and shown as karaoke lines.
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  await page.locator(".practice-lyrics-editor textarea").fill("La la la la\nOh oh oh oh\nHey hey hey");
  await page.getByRole("button", { name: "Place on the voice" }).click();
  await expect(page.locator(".practice-lyrics-list .practice-lyrics-text")).toHaveText(["La la la la", "Oh oh oh oh", "Hey hey hey"]);
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();

  // Sections: found and offered as loops.
  await page.getByRole("button", { name: "Find the song's sections" }).click();
  await expect(page.locator(".practice-message")).toContainText(/Click a section|No sections/, { timeout: 30_000 });

  // A key change: rendered in the worker, then the notes move up with it.
  await page.locator(".practice-bar select").nth(1).selectOption("2");
  await expect(page.locator(".practice-info")).toContainText("G major → A major · +2 st", { timeout: 30_000 });

  // After a reload, the song is picked up again and is in the library.
  await page.reload();
  await expect(page.locator(".practice-song")).toHaveText("Scale study", { timeout: 15_000 });
  await expect(page.locator(".practice-info")).toContainText("+2 st"); // still in the new key
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".practice-library")).toContainText("Scale study");
});

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
  test.setTimeout(420_000); // one Worker on CI's 4 cores: about 2 minutes for these 8 seconds
  await page.goto("/");
  await keepModel(page, model!);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();

  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-open").click();
  await (await choosing).setFiles({ name: "Whole song.wav", mimeType: "audio/wav", buffer: singingWav(8) });
  await expect(page.locator(".practice-progress-text")).toContainText(/Loading|Taking the voice/, { timeout: 30_000 });
  await expect(page.locator(".practice-song")).toHaveText("Whole song", { timeout: 360_000 });
  await expect(page.locator(".tracks-rows .track")).toHaveCount(2);
});
