import { expect, test } from "@playwright/test";

// Undo/redo of the Live sound and scenes, as in the desktop app.

test("undo puts the sound before a preset back, and redo brings it again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const [undo, redo] = [page.locator(".live-undo button").nth(0), page.locator(".live-undo button").nth(1)];
  await expect(undo).toBeDisabled();

  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Robot$/ }).click();
  const robot = page.locator('.effect-item[data-learn="param:robotOn"]');
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAttribute("aria-label", /Undo Load preset Robot/);

  await page.keyboard.press("Control+z");
  await expect(robot).toHaveAttribute("aria-pressed", "false");
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".preset-name")).toHaveText("Robot");

  // A switch flipped on the page is a step of its own, named after it.
  await page.locator('.effect-item[data-learn="param:denoiseOn"]').click();
  await expect(undo).toHaveAttribute("aria-label", /Undo Denoise/);
});

test("scenes save the sound, recall it, and stay after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const bar = page.locator(".scene-bar");
  const robot = page.locator('.effect-item[data-learn="param:robotOn"]');

  await bar.locator(".scene-add").click();
  await expect(bar.locator(".scene")).toHaveText(["Scene 1"]);
  await robot.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await bar.locator(".scene-add").click();
  await expect(bar.locator(".scene")).toHaveText(["Scene 1", "Scene 2"]);

  await bar.locator(".scene", { hasText: "Scene 1" }).click();
  await expect(robot).toHaveAttribute("aria-pressed", "false"); // after the glide
  await page.keyboard.press("]");
  await expect(robot).toHaveAttribute("aria-pressed", "true");

  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator(".scene-bar .scene")).toHaveText(["Scene 1", "Scene 2"]);
});
