import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Installable and offline: the service worker keeps every file of the app once it has loaded.
// (Playwright's offline mode doesn't let a reloaded page reach its service worker, so this
// checks that every file the app needs is served from the cache with the network off.)

test("keeps the whole app for offline use, and links to its source", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".effect-item").first()).toBeVisible();
  await expect(page.locator(".web-source:visible").first()).toHaveAttribute("href", "source.zip");
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

/** The build, served by a server of the test's own, where the next deploy's sw.js can be swapped in. */
async function serveBuild(): Promise<{ url: string; next(): void; close(): Promise<void> }> {
  const root = fileURLToPath(new URL("../dist/", import.meta.url));
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav" };
  let nextVersion = false;
  const server = createServer((request, response) => {
    let path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = join(root, normalize(path));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    let body: Buffer | string = readFileSync(file);
    if (path === "/sw.js" && nextVersion) body = body.toString().replace(/const CACHE = "micfx-voice-([0-9a-f]+)"/, 'const CACHE = "micfx-voice-$1next"');
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, next: () => (nextVersion = true), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("a new version waits, says so, and starts on Restart now", async ({ page }) => {
  const build = await serveBuild();
  try {
    await page.goto(build.url);
    await expect(page.locator(".effect-item").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    // (a reload can be under way: then ask again)
    const cacheNames = () => page.evaluate(() => caches.keys()).catch(() => [] as string[]);
    const [first] = await cacheNames();
    expect(first).toMatch(/^micfx-voice-[0-9a-f]+$/);

    // The next deploy: the same files under a new version, found by the update check.
    build.next();
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    const notice = page.locator(".web-update");
    await expect(notice).toContainText("A new version of MicFX is ready", { timeout: 15_000 });

    // Until then, this version keeps running: a reload is still on it, and says so again.
    await page.reload();
    await expect(page.locator(".effect-item").first()).toBeVisible();
    await expect(notice).toBeVisible({ timeout: 15_000 });
    expect(await cacheNames()).toContain(first);

    await notice.getByRole("button", { name: "Restart now" }).click();
    await expect.poll(cacheNames, { timeout: 15_000 }).toEqual([`${first}next`]);
    await expect(page.locator(".effect-item").first()).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    await build.close();
  }
});
