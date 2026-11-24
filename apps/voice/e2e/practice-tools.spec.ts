import { expect, test } from "@playwright/test";
import { singingWav } from "./singing";

// Range finder and warm-ups (plan section 9, points 16 and 17).

async function openPractice(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();
  await expect(page.locator(".practice-bar")).toBeVisible();
}

test("the range test hears a held note, and a kept range offers each song its key", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openPractice(page);

  await page.getByRole("button", { name: "Range", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Find your range" });
  await dialog.getByRole("button", { name: "Sing lowest" }).click();
  // The fake mic holds one "ah": it's heard as a note.
  await expect(dialog.locator(".web-range-note").first()).toHaveText(/^[A-G][♯♭]?\d$/, { timeout: 10_000 });
  await dialog.getByRole("button", { name: "Sing highest" }).click();
  await expect(dialog.locator(".web-range-status").nth(1)).toHaveText(/Got it|No steady note/, { timeout: 10_000 });
  // The same note twice isn't a range.
  await expect(dialog.getByRole("button", { name: "Keep this range" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();

  // With a range kept (C2 to A3), the song (G3 to C4 as recorded) is too high: 3 to 5 semitones down fits.
  await page.evaluate(() => localStorage.setItem("micfx.range", JSON.stringify({ low: 36, high: 57, at: Date.now() })));
  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-voice").click();
  await (await choosing).setFiles({ name: "Scale study.wav", mimeType: "audio/wav", buffer: singingWav(16) });
  await expect(page.locator(".practice-message")).toContainText("Ready", { timeout: 30_000 });
  const fit = page.locator(".web-fit-button");
  await expect(fit).toHaveText(/^Fits you: −[3-5] st$/);
  const down = (await fit.textContent())!.replace("Fits you: ", "");
  await fit.click();
  await expect(page.locator(".practice-info")).toContainText(down, { timeout: 30_000 });
  await expect(fit).toBeHidden();
  expect(errors).toEqual([]);
});

test("a warm-up is made in the key asked for, then sung and scored like a song", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openPractice(page);

  await page.getByRole("button", { name: "Warm-ups", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Warm-ups" });
  await dialog.locator(".web-warmup-exercise").selectOption("arpeggio");
  await dialog.locator(".web-warmup-root").selectOption("50");
  await dialog.locator(".web-warmup-rounds").selectOption("2");
  await expect(dialog).toContainText("D3 to E♭4");
  await dialog.getByRole("button", { name: "Sing it" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".practice-song")).toHaveText("Warm-up: Arpeggio from D3");
  // Two rounds of an arpeggio, a phrase each.
  await expect(page.locator(".practice-phrase")).toHaveCount(2);

  await page.locator('[data-transport="play"]').click();
  await expect(page.locator(".practice-pass-value")).not.toHaveText("–", { timeout: 15_000 });
  await page.locator('[data-transport="play"]').click();

  // It's in the library like any song.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".practice-library")).toContainText("Warm-up: Arpeggio from D3");
  expect(errors).toEqual([]);
});
