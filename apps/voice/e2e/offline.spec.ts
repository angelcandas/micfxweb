import { expect, test } from "@playwright/test";

// Installable and offline: the service worker keeps every file of the app once it has loaded.
// (Playwright's offline mode doesn't let a reloaded page reach its service worker, so this
// checks that every file the app needs is served from the cache with the network off.)

test("keeps the whole app for offline use, and links to its source", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".effect-item").first()).toBeVisible();
  await expect(page.locator(".web-source:visible").first()).toHaveAttribute("href", "https://github.com/angelcandas/micfxweb");
  const manifest = await page.evaluate(() => fetch(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href).then((r) => r.json()));
  expect(manifest).toMatchObject({ name: "MicFX Voice", display: "standalone" });

  const files = await page.evaluate(async () => {
    const text = await (await fetch("sw.js")).text();
    return JSON.parse(text.match(/const FILES = (\[.*\]);/)![1]!) as string[];
  });
  expect(files).toEqual(expect.arrayContaining(["./", "desktop/app.js", "desktop/index.html"]));
  expect(files.some((file) => file.endsWith(".wasm"))).toBe(true);

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  const missing = await page.evaluate(async (list) => {
    const failed: string[] = [];
    for (const file of list) {
      const ok = await fetch(file).then((r) => r.ok, () => false);
      if (!ok) failed.push(file);
    }
    return failed;
  }, files);
  expect(missing).toEqual([]);
});
