import { expect, test } from "@playwright/test";

// Audio settings' sample rate and low latency switch (shared with MicFX DAW), and the
// starting sound: just a small reverb, nothing that adds delay.

test("the sample rate and low latency switch restart the sound with them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".audio-status:visible").click();
  const dialog = page.getByRole("dialog", { name: "Audio settings" });
  await expect(dialog.getByRole("button", { name: "Stop sound" })).toBeVisible();
  const rate = dialog.getByLabel("Sample rate");
  const low = dialog.getByLabel("Low latency");
  await expect(rate).toHaveValue("0");
  await expect(low).toBeChecked();
  await expect(dialog.locator(".web-latency-parts")).toContainText("buffer");
  await page.screenshot({ path: "test-results/voice-audio-settings.png" });

  // 96 kHz: the browser's buffer is half as long.
  await rate.selectOption("96000");
  await expect(page.locator(".audio-status:visible")).toContainText("96 kHz");
  await expect(dialog.locator(".web-latency-parts")).toContainText("at 96 kHz");
  await low.uncheck();
  await expect(dialog.getByRole("button", { name: "Stop sound" })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("micfx.audio.prefs") ?? "{}"))).toEqual({ rate: 96000, lowLatency: false });

  // Kept after a reload.
  await page.reload();
  await page.locator(".audio-status:visible").click();
  await expect(dialog.getByLabel("Sample rate")).toHaveValue("96000");
  await expect(dialog.getByLabel("Low latency")).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("the first sound is the voice with a small reverb: no noise reduction, gate or compressor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const on = (id: string) => page.locator(`.effect-item[data-learn="param:${id}"]`);
  await expect(on("reverbOn")).toHaveAttribute("aria-pressed", "true");
  for (const id of ["denoiseOn", "gateOn", "compOn", "hpfOn"]) await expect(on(id)).toHaveAttribute("aria-pressed", "false");
});
