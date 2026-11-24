import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { singingWav } from "./singing";

// Progress over time and the result card (plan section 9, points 15 and 19): each pass is
// kept with the song and charted on the report, and the pass saves as a picture.

test("each pass is kept and charted, and the pass saves as a picture", async ({ page }) => {
  test.setTimeout(90_000);
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

  const report = page.locator(".practice-report");
  const sing = async () => {
    await page.locator('[data-transport="play"]').click();
    await expect(page.locator(".practice-pass-value")).not.toHaveText("–", { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.locator('[data-transport="play"]').click();
    await expect(report).toBeVisible();
  };

  await sing();
  await expect(report.locator(".web-progress-line")).toContainText("1 pass");
  await expect(report.locator(".web-progress-dot")).toHaveCount(1);

  const downloading = page.waitForEvent("download");
  await report.getByRole("button", { name: "Save as picture" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^Scale study - \d+\.png$/);
  const png = readFileSync((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1200);

  // A second pass from the start; after a reload, both are still there.
  await report.locator(".practice-report-close").click();
  await page.locator(".practice-restart").click();
  await page.waitForTimeout(6000);
  await page.locator('[data-transport="play"]').click();
  await expect(report).toBeVisible();
  await expect(report.locator(".web-progress-dot")).toHaveCount(2);
  await expect(report.locator(".web-progress-line")).toContainText("2 passes");

  await page.reload();
  await expect(page.locator(".practice-song")).toHaveText("Scale study", { timeout: 15_000 });
  await page.locator(".practice-report-button").click();
  await expect(report.locator(".web-progress-line")).toContainText("2 passes");
  expect(errors).toEqual([]);
});
