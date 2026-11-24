import { expect, test } from "@playwright/test";
import { singingWav } from "./singing";

// Between MicFX Voice and MicFX DAW (plan point 28). MicFX DAW is played here by a small
// page on its port (4175) that speaks the hand-off messages.

const RECEIVER = `<!doctype html><title>DAW</title><script>
  const id = new URLSearchParams(location.search).get("handoff");
  window.received = null;
  addEventListener("message", (event) => {
    if (event.data?.type !== "micfx-handoff" || event.data.id !== id) return;
    window.received = event.data.payload.items.map((item) => ({ name: item.name, role: item.role, bytes: item.data.byteLength }));
    opener.postMessage({ type: "micfx-handoff-done", id, ok: true, message: "Added 2 tracks to MicFX DAW." }, event.origin);
  });
  opener.postMessage({ type: "micfx-handoff-ready", id }, "*");
</script>`;

const SENDER = `<!doctype html><title>DAW</title><button id="send">Sing over it</button><script>
  window.answer = null;
  document.getElementById("send").addEventListener("click", async () => {
    const id = "test-handoff";
    const wav = await (await fetch("/mix.wav")).arrayBuffer();
    const voice = open("http://localhost:4173/?handoff=" + id, "micfx-voice");
    addEventListener("message", (event) => {
      if (event.source !== voice || event.data?.id !== id) return;
      if (event.data.type === "micfx-handoff-ready")
        voice.postMessage({ type: "micfx-handoff", id, payload: { from: "daw", items: [{ kind: "audio", name: "Song mix.wav", data: wav, role: "mix" }] } }, event.origin, [wav]);
      else if (event.data.type === "micfx-handoff-done") window.answer = event.data;
    });
  });
</script>`;

test("takes and the song go to MicFX DAW, lined up", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("http://localhost:4175/**", (route) => route.fulfill({ contentType: "text/html", body: RECEIVER }));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  const send = page.getByRole("button", { name: "Send to DAW" });
  await expect(send).toBeDisabled();

  const chooser = page.waitForEvent("filechooser");
  await page.locator(".add-track").first().click();
  await (await chooser).setFiles({ name: "Scale study.wav", mimeType: "audio/wav", buffer: singingWav(4) });
  await expect(page.locator(".tracks-rows .track")).toHaveCount(1);
  // A take.
  await page.locator(".recorder .record-button").click();
  await page.waitForTimeout(1500);
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".tracks-rows .track")).toHaveCount(2, { timeout: 10_000 });

  const opening = context.waitForEvent("page");
  await send.click();
  const daw = await opening;
  await expect.poll(() => daw.evaluate(() => (window as any).received), { timeout: 15_000 }).not.toBeNull();
  const received = (await daw.evaluate(() => (window as any).received)) as { name: string; role: string; bytes: number }[];
  expect(received.map((r) => r.role).sort()).toEqual(["backing", "take"]);
  expect(received.find((r) => r.role === "backing")!.name).toBe("Scale study.wav");
  for (const item of received) expect(item.bytes).toBeGreaterThan(1000);
  await expect(page.locator(".record-status")).toHaveText("Added 2 tracks to MicFX DAW.");
  expect(errors).toEqual([]);
});

test("MicFX DAW's mix opens in Voice as the backing track", async ({ page, context }) => {
  const wav = singingWav(3);
  await context.route("http://localhost:4175/mix.wav", (route) => route.fulfill({ contentType: "audio/wav", body: wav }));
  await context.route("http://localhost:4175/", (route) => route.fulfill({ contentType: "text/html", body: SENDER }));
  await page.goto("http://localhost:4175/");
  const opening = context.waitForEvent("page");
  await page.locator("#send").click();
  const voice = await opening;
  const errors: string[] = [];
  voice.on("pageerror", (error) => errors.push(error.message));
  await expect.poll(() => page.evaluate(() => (window as any).answer), { timeout: 20_000 }).toMatchObject({ ok: true });
  await expect(voice.locator(".tracks-rows .track .track-name")).toHaveText(["Song mix"]);
  // The address loses ?handoff, so a reload doesn't wait for another.
  expect(new URL(voice.url()).search).toBe("");
  expect(errors).toEqual([]);
});
