import { expect, test, type Page } from "@playwright/test";

// The desktop app's Live UI on the web bridge, with the engine playing the fake mic.

async function meters(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ input: number; output: number; fx: Record<string, unknown> }>((resolve) => {
        const backend = (window as any).__JUCE__.backend;
        const handle = backend.addEventListener("meters", (m: any) => {
          backend.removeEventListener(handle);
          resolve(m);
        });
      }),
  );
}

test("the desktop Live UI runs on the web bridge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));

  await page.goto("/");
  await expect(page.locator(".effect-item").first()).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-platform", "web");

  // The first-run card's "I'm wearing headphones" starts the mic (the click browsers need).
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await expect(page.locator(".audio-status").first()).toContainText("round trip");
  await expect(page.locator(".audio-status").first()).not.toContainText("input muted");
  await page.getByRole("button", { name: "Done" }).click();

  await expect.poll(async () => (await meters(page)).output).toBeGreaterThan(-40);

  // A factory preset from the preset menu: its effects light up in the list.
  await page.locator(".preset-button").click();
  await page.locator('.preset-load', { hasText: /^Robot$/ }).click();
  await expect(page.locator(".preset-name")).toHaveText("Robot");
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Object.keys((await meters(page)).fx)).toContain("robot");

  // Switching an effect in the list reaches the engine (its live reading appears).
  const denoise = page.locator('.effect-item[data-learn="param:denoiseOn"]');
  await denoise.click();
  await expect(denoise).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Object.keys((await meters(page)).fx)).toContain("denoise");

  expect(errors).toEqual([]);
});

test("parts the browser can't do yet are hidden", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".effect-item").first()).toBeVisible();
  for (const selector of [".mode-switch", ".practice-toggle", ".midi-button", ".record-button", ".computer-audio"])
    await expect(page.locator(selector).first()).toBeHidden();
});
