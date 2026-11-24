import { expect, test } from "@playwright/test";

test("the mic goes through the engine to the output", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Start mic" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-audio", "on");

  // The fake mic's beep shows on both meters.
  await expect.poll(async () => page.locator('[data-meter="output"]').evaluate((el) => parseFloat(el.style.width) || 0)).toBeGreaterThan(10);
  await expect.poll(async () => page.locator('[data-meter="input"]').evaluate((el) => parseFloat(el.style.width) || 0)).toBeGreaterThan(10);
  await expect(page.locator(".latency")).toContainText("ms latency");

  // Effects switch on and off.
  const reverb = page.getByRole("button", { name: /Reverb/ });
  await reverb.click();
  await expect(reverb).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-audio", "off");
  expect(errors).toEqual([]);
});
