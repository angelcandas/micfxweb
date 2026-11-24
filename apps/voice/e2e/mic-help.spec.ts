import { expect, test } from "@playwright/test";

// The first-run card's microphone help (plan section 9, point 12): blocked, the steps for this
// browser show; allowed again, "Try again" starts the sound.

test("a blocked microphone gets this browser's steps and a Try again", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __micBlocked: boolean };
    w.__micBlocked = true;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      w.__micBlocked ? Promise.reject(new DOMException("Permission denied", "NotAllowedError")) : real(constraints);
  });
  await page.goto("/");
  const card = page.locator(".first-run");
  const help = card.locator(".web-mic-help");
  await expect(help).toBeHidden();
  await card.getByRole("button", { name: "I'm wearing headphones" }).click();
  await expect(help).toBeVisible();
  await expect(help).toContainText("address bar"); // Chromium's steps
  await expect(page.locator(".recorder .record-status")).toContainText("Try again");
  // No half-started sound: the first step isn't ticked.
  await expect(card.locator(".setup-step").first()).not.toHaveClass(/is-done/);

  await page.evaluate(() => ((window as unknown as { __micBlocked: boolean }).__micBlocked = false));
  await help.getByRole("button", { name: "Try again" }).click();
  await expect(help).toBeHidden();
  await expect(card.getByRole("button", { name: "I'm wearing headphones" })).toBeHidden();
  await expect(card.locator(".setup-step").first()).toHaveClass(/is-done/);
});
