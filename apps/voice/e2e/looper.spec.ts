import { expect, test, type Page } from "@playwright/test";

// The Live looper, playing in the engine (the desktop's Looper compiled to wasm).

async function looper(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ state: string; layers: number; length: number }>((resolve) => {
        const backend = (window as any).__JUCE__.backend;
        const handle = backend.addEventListener("meters", (m: any) => {
          backend.removeEventListener(handle);
          resolve(m.looper);
        });
      }),
  );
}

test("record a loop, overdub it, and save the layers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await page.locator(".loop-toggle:not(.inst-toggle-chip)").click();
  const main = page.locator(".loop-main");
  await expect(main).toBeVisible();
  await main.click(); // record the first layer (the fake mic sings)
  await expect.poll(async () => (await looper(page)).state).toBe("recording");
  await page.waitForTimeout(1200);
  await main.click(); // close it: it plays
  await expect.poll(async () => (await looper(page)).state).toBe("playing");
  expect((await looper(page)).length).toBeGreaterThan(1);

  await main.click(); // overdub
  await expect.poll(async () => (await looper(page)).state).toBe("overdubbing");
  await page.waitForTimeout(600);
  await main.click();
  await expect.poll(async () => (await looper(page)).layers).toBe(2);

  // Save WAV downloads each layer.
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.locator(".loop-save").click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads[0]).toMatch(/^Loop .* - layer 1\.wav$/);
  await expect(page.locator(".loop-send")).toBeHidden();
});
