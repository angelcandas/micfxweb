import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The sing-along recorder: a backing song, recording takes over it, and the song's key.

/** 12 s of A minor chords (Am, Dm, E, Am) as a 16-bit WAV. */
function song(): string {
  const rate = 22050;
  const chords = [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]];
  const frames = rate * 12;
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
  for (let i = 0; i < frames; ++i) {
    const chord = chords[Math.floor(i / (rate * 3)) % chords.length]!;
    let s = 0;
    for (const note of chord) {
      const f = 440 * 2 ** ((note - 69) / 12);
      s += Math.sin((2 * Math.PI * f * i) / rate) + 0.5 * Math.sin((4 * Math.PI * f * i) / rate);
    }
    data.writeInt16LE(Math.round(0.08 * s * 32767), 44 + i * 2);
  }
  const file = join(mkdtempSync(join(tmpdir(), "micfx-")), "Minor Song.wav");
  writeFileSync(file, data);
  return file;
}

async function transport(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ position: number; length: number; playing: boolean }>((resolve) => {
        const backend = (window as any).__JUCE__.backend;
        const handle = backend.addEventListener("meters", (m: any) => {
          backend.removeEventListener(handle);
          resolve(m.transport);
        });
      }),
  );
}

test("load a song, record over it, and keep both", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  // "+ Backing track" opens the browser's file picker.
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".add-track").first().click();
  await (await chooser).setFiles(song());
  const rows = page.locator(".tracks-rows .track");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".track-name")).toHaveText("Minor Song");
  await expect.poll(async () => (await transport(page)).length).toBeCloseTo(12, 0);

  // Play moves the playhead; pause holds it.
  await page.locator('[data-transport="play"]').click();
  await expect.poll(async () => (await transport(page)).position).toBeGreaterThan(0.3);
  await page.locator('[data-transport="play"]').click();
  await expect.poll(async () => (await transport(page)).playing).toBe(false);
  await page.locator('[data-transport="stop"]').click();
  await expect.poll(async () => (await transport(page)).position).toBe(0);

  // Record a take over the song (the fake mic sings): a second row and a saved take.
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-label")).toHaveText("Stop");
  await page.waitForTimeout(1500);
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-status")).toContainText("Saved");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator(".track-name")).toHaveText("Recording 1");

  // The take is the voice all the way through, kept in the browser as a WAV.
  const take = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve) => {
      const open = indexedDB.open("micfx-voice");
      open.onsuccess = () => resolve(open.result);
    });
    const tracks: { isTake: boolean; audio: Blob }[] = await new Promise((resolve) => {
      const all = db.transaction("tracks").objectStore("tracks").getAll();
      all.onsuccess = () => resolve(all.result);
    });
    const wav = tracks.find((t) => t.isTake)!.audio;
    const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await wav.arrayBuffer());
    const samples = audio.getChannelData(0);
    let sounding = 0;
    for (let at = 0; at < samples.length; at += 4800) {
      let peak = 0;
      for (let i = at; i < Math.min(samples.length, at + 4800); ++i) peak = Math.max(peak, Math.abs(samples[i]!));
      if (peak > 0.05) sounding++;
    }
    return { seconds: audio.duration, sounding: sounding / Math.ceil(samples.length / 4800) };
  });
  expect(take.seconds).toBeGreaterThan(1.2);
  expect(take.sounding).toBeGreaterThan(0.9);

  // "Show" downloads the take as a WAV.
  const download = page.waitForEvent("download");
  await page.locator(".recorder .record-status button", { hasText: "Show" }).click();
  expect((await download).suggestedFilename()).toMatch(/^MicFX .*\.wav$/);

  // Muting a row sticks, and both tracks come back after a reload.
  await rows.first().locator(".track-mute").click();
  await page.waitForTimeout(300);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".track-mute")).toHaveAttribute("aria-pressed", "true");

  // Removing one forgets it.
  await rows.nth(1).locator(".track-remove").click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(rows).toHaveCount(1);

  expect(errors).toEqual([]);
});

test("Match song finds the backing track's key", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".add-track").first().click();
  await (await chooser).setFiles(song());
  await expect(page.locator(".tracks-rows .track")).toHaveCount(1);

  const autotune = page.locator('.effect-item[data-learn="param:tuneOn"]');
  await autotune.click();
  const match = page.locator(".key-match:visible").first();
  await match.click();
  await expect(match).toHaveText("Match song", { timeout: 20_000 }); // "Listening…" while it works
  // The result is in its tooltip (title, or data-tip once the app's tooltips took it over).
  await expect
    .poll(() => match.evaluate((element) => element.getAttribute("title") ?? (element as HTMLElement).dataset.tip ?? ""))
    .toMatch(/Minor Song: A minor/);
});
