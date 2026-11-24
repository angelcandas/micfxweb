import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Video with your voice (plan section 9, point 8): the fake camera and what you hear,
// recorded to a video file with a look before saving.

function streams(path: string): string[] | undefined {
  try {
    return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return undefined; // no ffprobe here
  }
}

test("records the camera with the voice, then saves it", async ({ page }) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await page.locator(".web-video-button").click();
  const dialog = page.getByRole("dialog", { name: "Record a video" });
  await expect(dialog.locator(".web-video-status")).toContainText("Ready", { timeout: 15_000 });
  await dialog.getByLabel("Shape of the video").selectOption("tall");
  await expect(dialog.locator("canvas")).toHaveJSProperty("height", 1280);

  await dialog.getByRole("button", { name: "Record" }).click();
  await expect(dialog.locator(".web-video-status")).toContainText("Recording 0:0");
  await page.waitForTimeout(2200);
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(dialog.locator(".web-video-status")).toContainText("recorded");
  await expect(dialog.locator(".web-video-result")).toBeVisible();

  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save video" }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toMatch(/^MicFX video .*\.(mp4|webm)$/);
  const kinds = streams((await file.path())!);
  if (kinds) expect(kinds.sort()).toEqual(["audio", "video"]);

  await dialog.getByRole("button", { name: "Record again" }).click();
  await expect(dialog.getByRole("button", { name: "Record" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
