import { expect, test } from "@playwright/test";

// Show mode (plan section 9, point 10): the stage view fills the screen, keeps it awake, and
// pedals that send arrow keys step through the songs.

test("the stage view goes full screen, stays awake, and arrows step through the show", async ({ page }) => {
  // The wake lock as the browser gives it (headless Chromium has none of its own).
  await page.addInitScript(() => {
    const w = window as unknown as { __locks: number };
    w.__locks = 0;
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => {
          w.__locks++;
          const listeners: (() => void)[] = [];
          return { release: async () => (w.__locks--, listeners.forEach((l) => l())), addEventListener: (_: string, l: () => void) => listeners.push(l) };
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".setlist-button").click();
  const drawer = page.locator(".setlist-drawer");
  for (const [name, lyrics] of [["Opener", "Hello there"], ["Closer", "Goodnight now"]]) {
    await drawer.getByRole("button", { name: "+ Add the current sound as a song" }).click();
    await drawer.locator(".setlist-input").first().fill(name!);
    await drawer.locator(".setlist-input").first().press("Enter");
    await drawer.locator(".setlist-lyrics").fill(lyrics!);
    await drawer.locator(".setlist-lyrics").blur();
  }
  await drawer.locator(".setlist-song-name", { hasText: "Opener" }).click();
  await drawer.getByRole("button", { name: "Stage view" }).click();

  const stage = page.locator(".stage-view");
  await expect(stage).toBeVisible();
  await expect(stage.locator(".stage-title")).toHaveText("Opener");
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __locks: number }).__locks)).toBe(1);
  await expect(stage.getByRole("button", { name: "Leave full screen" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(stage.locator(".stage-title")).toHaveText("Closer");
  await expect(stage.locator(".stage-lyrics")).toContainText("Goodnight now");
  await page.keyboard.press("ArrowLeft");
  await expect(stage.locator(".stage-title")).toHaveText("Opener");

  await stage.getByRole("button", { name: "Close", exact: true }).click();
  await expect(stage).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __locks: number }).__locks)).toBe(0);
});
