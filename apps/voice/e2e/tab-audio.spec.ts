import { expect, test, type Page } from "@playwright/test";

// Sing along to a browser tab (plan section 9, point 9). Headless Chromium has no tab picker,
// so the shared "tab" here is a 3 kHz tone made in the page: the test follows it from the
// share into what you hear and into the take.

async function fakeTab(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tabShares: number; __tabStream?: MediaStream };
    w.__tabShares = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      w.__tabShares++;
      const context = new AudioContext();
      const tone = new OscillatorNode(context, { frequency: 3000 });
      const out = context.createMediaStreamDestination();
      tone.connect(new GainNode(context, { gain: 0.3 })).connect(out);
      tone.start();
      await context.resume();
      const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 36 });
      canvas.getContext("2d")!.fillRect(0, 0, 64, 36);
      const stream = new MediaStream([...canvas.captureStream(5).getVideoTracks(), ...out.stream.getAudioTracks()]);
      w.__tabStream = stream;
      return stream;
    };
  });
}

/** The newest take's 3 kHz share of its energy (Goertzel over its WAV). */
async function toneInTake(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve) => {
      const open = indexedDB.open("micfx-voice");
      open.onsuccess = () => resolve(open.result);
    });
    const rows: { isTake: boolean; audio: Blob; id: number }[] = await new Promise((resolve) => {
      const req = db.transaction("tracks").objectStore("tracks").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    const take = rows.filter((r) => r.isTake).sort((a, b) => b.id - a.id)[0]!;
    const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await take.audio.arrayBuffer());
    const x = buffer.getChannelData(0);
    const k = (2 * Math.PI * 3000) / buffer.sampleRate;
    let s1 = 0;
    let s2 = 0;
    let energy = 0;
    for (const v of x) {
      const s0 = v + 2 * Math.cos(k) * s1 - s2;
      s2 = s1;
      s1 = s0;
      energy += v * v;
    }
    const power = s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2;
    return (2 * power) / (x.length * Math.max(energy, 1e-12));
  });
}

async function record(page: Page) {
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-label")).toHaveText("Stop");
  await page.waitForTimeout(1500);
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-status")).toContainText("Saved");
}

test("a shared tab plays under the voice and goes in the take", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fakeTab(page);
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  const panel = page.locator(".computer-audio");
  await expect(panel).toBeVisible();
  const toggle = panel.locator(".computer-toggle");
  await expect(toggle).toHaveText("Tab audio");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".recorder .record-status")).toContainText("A browser tab");
  // The meter hears it.
  await expect.poll(async () => panel.locator(".computer-meter-fill").evaluate((e) => parseFloat((e as HTMLElement).style.width) || 0)).toBeGreaterThan(40);

  // In recordings (the default): the take has the tab under the voice.
  await record(page);
  // (the starting sound has no compressor, so the voice keeps its full level beside it)
  expect(await toneInTake(page)).toBeGreaterThan(0.05);

  // Not in recordings: the voice alone.
  await panel.getByLabel("Tab audio options").click();
  await expect(panel.locator(".web-tab-hint")).toContainText("Chrome and Edge");
  await panel.getByLabel("In recordings").uncheck();
  await panel.getByLabel("Tab audio options").click();
  await expect(panel.locator(".computer-options")).toBeHidden();
  await record(page);
  expect(await toneInTake(page)).toBeLessThan(0.02);

  // "Stop sharing" in the browser turns it off.
  await page.evaluate(() => {
    const stream = (window as unknown as { __tabStream: MediaStream }).__tabStream;
    for (const track of stream.getTracks()) {
      track.stop();
      track.dispatchEvent(new Event("ended"));
    }
  });
  await expect(page.locator(".recorder .record-status")).toContainText("stopped sharing");
  expect(errors).toEqual([]);
});

test("a browser that shares no tab sound says so", async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as { CaptureController?: unknown }).CaptureController);
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".computer-audio .computer-toggle").click();
  await expect(page.locator(".recorder .record-status")).toContainText("Use Chrome or Edge");
  await expect(page.locator(".computer-audio .computer-toggle")).toHaveAttribute("aria-pressed", "false");
});
