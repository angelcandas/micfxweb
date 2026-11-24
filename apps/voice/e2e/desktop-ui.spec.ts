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
  await expect(page.locator(".audio-status:visible")).toContainText("round trip");
  await expect(page.locator(".audio-status:visible")).not.toContainText("input muted");
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
  for (const selector of [".mode-switch", ".practice-toggle", ".record-change", ".computer-audio"])
    await expect(page.locator(selector).first()).toBeHidden();
});

test("the session comes back after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Demon$/ }).click();
  const denoise = page.locator('.effect-item[data-learn="param:denoiseOn"]');
  await denoise.click();
  await expect(denoise).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(600); // saved after a short pause

  await page.reload();
  await expect(page.locator(".preset-name")).toHaveText("Demon");
  await expect(page.locator('.effect-item[data-learn="param:denoiseOn"]')).toHaveAttribute("aria-pressed", "true");
});

test("audio settings pick the mic and start or stop the sound", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".audio-status:visible").click();
  const dialog = page.getByRole("dialog", { name: "Audio settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Microphone")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Stop sound" })).toBeVisible(); // the click started it
  await expect(page.locator(".audio-status:visible")).not.toContainText("input muted");
  await dialog.getByRole("button", { name: "Stop sound" }).click();
  await expect(dialog.getByRole("button", { name: "Start sound" })).toBeVisible();
  await expect(page.locator(".audio-status:visible")).toContainText("input muted");
});

test("your own sounds are saved in the browser and play again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Robot$/ }).click();

  // Save the sound from the preset menu's save row.
  await page.locator(".preset-button").click();
  const save = page.locator(".preset-menu").getByRole("button", { name: /Save/ }).first();
  await save.click();
  const input = page.locator(".preset-menu input[type=text], .preset-menu input:not([type])").last();
  await input.fill("My robot");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("micfx.library") ?? "{}").sounds ?? {}))).toContain("My robot");

  // Another preset, then the saved sound again.
  await page.locator(".preset-button").click();
  await page.locator(".preset-load", { hasText: /^Natural$/ }).click();
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator(".preset-button").click();
  await page.locator(".preset-menu").getByText("My robot", { exact: true }).click();
  await expect(page.locator('.effect-item[data-learn="param:robotOn"]')).toHaveAttribute("aria-pressed", "true");
});
