import { expect, test } from "@playwright/test";
import { singingWav } from "./singing";

// Practice on the web: a voice on its own is prepared (its melody found by analysis.wasm in
// a worker), kept in the browser's private files, and opens again from the library.

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
