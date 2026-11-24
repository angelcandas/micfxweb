import { expect, test } from "@playwright/test";
import { singingWav } from "./singing";

// Duet mode (plan section 9, point 20): a harmony part a third above or below, scored on its own.

test("a harmony part moves the notes a third in the key, is scored, and stays after a reload", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".practice-toggle").click();
  const choosing = page.waitForEvent("filechooser");
  await page.locator(".practice-voice").click();
  await (await choosing).setFiles({ name: "Scale study.wav", mimeType: "audio/wav", buffer: singingWav(16) });
  await expect(page.locator(".practice-message")).toContainText("Ready", { timeout: 30_000 });
  const info = page.locator(".practice-info");
  await expect(info).toContainText("G3 to C4");

  // A3 B3 C4 G3 B♭3 in G major, a third up: C4 D4 E4 B3 C♯4.
  const part = page.locator(".web-part-select");
  await part.selectOption("above");
  await expect(info).toContainText("B3 to E4");

  await page.locator('[data-transport="play"]').click();
  await expect(page.locator(".practice-pass-value")).not.toHaveText("–", { timeout: 15_000 });
  await page.locator('[data-transport="play"]').click();

  await page.reload();
  await expect(page.locator(".practice-song")).toHaveText("Scale study", { timeout: 15_000 });
  await expect(part).toHaveValue("above");
  await expect(info).toContainText("B3 to E4");
  await part.selectOption("lead");
  await expect(info).toContainText("G3 to C4");
  expect(errors).toEqual([]);
});
