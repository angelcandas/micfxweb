import { expect, test } from "@playwright/test";

test("the mic goes through the engine to the output", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/simple.html");
  await page.getByRole("button", { name: "Start mic" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-audio", "on");

  // The fake mic's beep shows on both meters.
  await expect.poll(async () => page.locator('[data-meter="output"]').evaluate((el) => parseFloat(el.style.width) || 0)).toBeGreaterThan(10);
  await expect.poll(async () => page.locator('[data-meter="input"]').evaluate((el) => parseFloat(el.style.width) || 0)).toBeGreaterThan(10);
  await expect(page.locator(".latency")).toContainText("ms latency");

  // Effects switch on and off.
  const robotButton = page.getByRole("button", { name: /Robot/ });
  await expect(robotButton).toHaveAttribute("aria-pressed", "false");
  await robotButton.click();
  await expect(robotButton).toHaveAttribute("aria-pressed", "true");
  await robotButton.click();

  // A factory preset from the desktop switches effects on and off.
  await page.getByLabel("Voice preset").selectOption({ label: "Robot" });
  await expect(page.getByRole("button", { name: /Robot/ })).toHaveAttribute("aria-pressed", "true");
  const robot = Number(await page.getByLabel("Voice preset").inputValue());
  await page.getByRole("button", { name: "Next preset" }).click();
  await expect(page.getByLabel("Voice preset")).toHaveValue(String(robot + 1));

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-audio", "off");
  expect(errors).toEqual([]);
});

test("lists the desktop's factory presets before the mic starts", async ({ page }) => {
  await page.goto("/simple.html");
  await expect(page.locator("body")).toHaveAttribute("data-catalog", "ready");
  const select = page.getByLabel("Voice preset");
  expect(await select.locator("option").count()).toBeGreaterThanOrEqual(24);
  expect(await select.locator("optgroup").evaluateAll((groups) => groups.map((g) => (g as HTMLOptGroupElement).label))).toEqual([
    "Clean", "Tuned", "Characters", "Lo-fi", "Space",
  ]);
  await select.selectOption({ label: "Podcast" });
  await expect(page.getByRole("button", { name: /Denoise/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Reverb/ })).toHaveAttribute("aria-pressed", "false");
});
