import { devices, expect, test } from "@playwright/test";

// Touch on a tablet (mobile plan, phase 4): press and hold is a right-click, a pinch zooms,
// the library starts folded, and the hint says so.
const { defaultBrowserType: _browser, ...tablet } = devices["iPad (gen 7) landscape"];
test.use(tablet);

test("a tablet gets the DAW with touch gestures", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Arm a track and press")).toBeVisible({ timeout: 30_000 }); // the DAW, not the phone page
  await expect(page.locator("body.web-touch")).toHaveCount(1);
  // The library starts folded on a small tablet.
  await expect(page.locator(".library-panel")).toBeHidden({ timeout: 15_000 });
  // The hint says "press and hold".
  await expect(page.locator(".hint-text").filter({ hasText: "Press and hold" })).toHaveCount(1);

  // Press and hold = contextmenu.
  const menus = await page.evaluate(() => {
    (window as unknown as { __menus: number }).__menus = 0;
    document.addEventListener("contextmenu", () => { (window as unknown as { __menus: number }).__menus++; }, true);
    return 0;
  });
  void menus;
  const target = page.locator(".track-name, .tt-arm, .arrange").first();
  const box = (await target.boundingBox())!;
  const at = { clientX: box.x + 20, clientY: box.y + 10 };
  const tap = (type: string, id: number, x = at.clientX, y = at.clientY) => page.evaluate(([t, i, cx, cy]) => {
    const el = document.elementFromPoint(cx as number, cy as number) ?? document.body;
    el.dispatchEvent(new PointerEvent(t as string, { pointerType: "touch", pointerId: i as number, clientX: cx as number, clientY: cy as number, bubbles: true, cancelable: true }));
  }, [type, id, x, y] as const);
  await tap("pointerdown", 1);
  await page.waitForTimeout(700);
  await tap("pointerup", 1);
  expect(await page.evaluate(() => (window as unknown as { __menus: number }).__menus)).toBe(1);

  // A short tap is not a long press.
  await tap("pointerdown", 2);
  await page.waitForTimeout(100);
  await tap("pointerup", 2);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as unknown as { __menus: number }).__menus)).toBe(1);

  // A pinch is Ctrl + wheel.
  await page.evaluate(() => {
    (window as unknown as { __zoom: number[] }).__zoom = [];
    document.addEventListener("wheel", (e) => { if (e.ctrlKey) (window as unknown as { __zoom: number[] }).__zoom.push(e.deltaY); }, true);
  });
  const x = box.x + 300, y = box.y + 80;
  await tap("pointerdown", 3, x - 40, y);
  await tap("pointerdown", 4, x + 40, y);
  await page.evaluate(([cx, cy]) => {
    for (const [id, dx] of [[3, -80], [4, 80]] as const) document.dispatchEvent(new PointerEvent("pointermove", { pointerType: "touch", pointerId: id, clientX: (cx as number) + dx, clientY: cy as number, bubbles: true }));
  }, [x, y]);
  await tap("pointerup", 3); await tap("pointerup", 4);
  const zoom = await page.evaluate(() => (window as unknown as { __zoom: number[] }).__zoom);
  expect(zoom.length).toBeGreaterThan(0);
  expect(zoom[0]).toBeLessThan(0); // fingers apart: zoom in (the desktop's negative deltaY)
  // (the synthetic pointers have no real capture: the app's setPointerCapture says so)
  expect(errors.filter((e) => !e.includes("setPointerCapture"))).toEqual([]);
});
