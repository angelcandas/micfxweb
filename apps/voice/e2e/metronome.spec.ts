import { expect, test } from "@playwright/test";

// The click, the shared tempo and a count-in before a take (plan section 9, point 3).

test("a take counts in, the tempo is the looper's, and the click is kept", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  const group = page.locator(".web-metronome");
  await group.getByLabel("Tempo (BPM)").fill("240");
  await group.getByLabel("Tempo (BPM)").press("Enter");
  await group.getByLabel("Count-in before a take").selectOption("1"); // a bar of 4: one second
  await group.locator(".web-click").click();
  await expect(group.locator(".web-click")).toHaveAttribute("aria-pressed", "true");

  // The looper has the same tempo.
  await page.locator(".loop-toggle, [data-view='looper'], button:has-text('Looper')").first().click();
  await expect(page.locator(".loop-bpm")).toHaveValue("240");
  await page.locator(".loop-toggle, [data-view='looper'], button:has-text('Looper')").first().click();

  // Record: the count-in shows its beats, then the take runs.
  await page.locator(".recorder .record-button").click();
  await expect(group.locator(".web-counting")).toHaveText(/^[1-4]…$/);
  await expect(group.locator(".web-counting")).toBeHidden({ timeout: 3000 });
  await page.waitForTimeout(1200);
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-status")).toContainText("Saved");
  const take = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve) => {
      const open = indexedDB.open("micfx-voice");
      open.onsuccess = () => resolve(open.result);
    });
    const rows: { isTake: boolean; length: number }[] = await new Promise((resolve) => {
      const req = db.transaction("tracks").objectStore("tracks").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    return rows.find((r) => r.isTake);
  });
  // About 1.2 s of take: the count-in's second isn't in it.
  expect(take!.length).toBeGreaterThan(0.8);
  expect(take!.length).toBeLessThan(2);

  await page.reload();
  await expect(group.locator(".web-click")).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByLabel("Count-in before a take")).toHaveValue("1");
  await expect(group.getByLabel("Tempo (BPM)")).toHaveValue("240");
  expect(errors).toEqual([]);
});
