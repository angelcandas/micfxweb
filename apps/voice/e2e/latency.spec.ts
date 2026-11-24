import { expect, test } from "@playwright/test";

// Latency calibration in Settings (plan section 9, point 2). The test browser's fake mic
// can't hear its own output, so a run here says the clicks weren't heard (the measuring
// itself is tested in the engine with a simulated room); a kept measure is then used.

test("calibration asks for speakers, says when it can't hear, and a measure replaces the estimate", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Control+Comma");
  const text = page.locator(".web-latency");
  await expect(text).toContainText("(estimated)");
  const reset = page.getByRole("button", { name: "Use the estimate" });
  await expect(reset).toBeHidden();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("8 clicks");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Measure…" }).click();
  await expect(text).toHaveText("Listening…");
  await expect(text).toContainText("Couldn't hear the clicks", { timeout: 15_000 });

  // A measure kept for these devices (as a run in a quiet room leaves it) is what's used.
  const rate = await page.evaluate(() => {
    const footer = document.querySelector(".audio-status")?.textContent ?? "";
    return /44\.1 kHz/.test(footer) ? 44100 : 48000;
  });
  await page.evaluate((key) => localStorage.setItem("micfx.latency", JSON.stringify({ [key]: 0.12 })), `default|default|${rate}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Comma");
  await expect(text).toContainText("(measured here)");
  const ms = Number(/(\d+) ms round trip/.exec((await text.textContent())!)![1]);
  expect(ms).toBeGreaterThanOrEqual(120);
  expect(ms).toBeLessThan(200);
  await reset.click();
  await expect(text).toContainText("(estimated)");
  expect(errors).toEqual([]);
});
