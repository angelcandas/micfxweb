import { expect, test, type Page } from "@playwright/test";
import { singingWav } from "./singing";

// Drag and drop anywhere (plan section 9, point 29).

/** Drops files (name, type, bytes) or text on the page, as the browser does. */
async function drop(page: Page, files: { name: string; type: string; data: number[] }[], text = "") {
  await page.evaluate(
    ({ files, text }) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([new Uint8Array(f.data)], f.name, { type: f.type }));
      if (text) data.setData("text/uri-list", text);
      const target = document.querySelector(".chain-grid") ?? document.body;
      for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    { files, text },
  );
}

const SETLIST = `<?xml version="1.0" encoding="UTF-8"?>
<SETLIST><SONG name="Opener" tempo="120"/><SONG name="Ballad" tempo="72"/></SETLIST>`;

test("dropped songs, a setlist and a sound's link each go where they belong", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  // A song on Live: a backing track.
  await drop(page, [{ name: "Scale study.wav", type: "audio/wav", data: [...singingWav(3)] }]);
  await expect(page.locator(".tracks-rows .track .track-name")).toHaveText(["Scale study"]);

  // A setlist: opened in the setlist.
  await drop(page, [{ name: "Friday.micfxset", type: "", data: [...Buffer.from(SETLIST)] }]);
  const drawer = page.locator(".setlist-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".setlist-song-name")).toContainText(["Opener", "Ballad"]);
  await drawer.locator(".setlist-close").click();

  // Something else: said so.
  await drop(page, [{ name: "photo.jpg", type: "image/jpeg", data: [1, 2, 3] }]);
  await expect(page.locator(".record-status")).toContainText("couldn't use one file");

  // A shared sound's link.
  const hash = Buffer.from(JSON.stringify({ v: 1, s: { robotOn: 1 }, n: "Dalek" })).toString("base64url");
  await drop(page, [], `https://example.com/#sound=${hash}`);
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("in Practice, dropped lyrics go on the song", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();
  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-voice").click();
  await (await choosing).setFiles({ name: "Scale study.wav", mimeType: "audio/wav", buffer: singingWav(16) });
  await expect(page.locator(".practice-message")).toContainText("Ready", { timeout: 30_000 });

  await drop(page, [{ name: "Scale study.lrc", type: "text/plain", data: [...Buffer.from("[00:00.50]La la la\n[00:03.70]Oh oh oh\n")] }]);
  await page.getByRole("button", { name: "Lyrics", exact: true }).click();
  await expect(page.locator(".practice-lyrics-list .practice-lyrics-text")).toHaveText(["La la la", "Oh oh oh"]);
});
