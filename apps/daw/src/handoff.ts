// handoff.html: MicFX DAW's door to MicFX Voice (plan point 28). It's served without
// cross-origin isolation, so it keeps the link to the window that opened it:
// - ?handoff=<id>: MicFX Voice opened it to send takes (or MIDI mappings). It keeps them in the
//   browser's storage and opens the DAW, which takes them in (main.ts).
// - ?send=<id>: the DAW opened it to send something to MicFX Voice (kept by the DAW page first).
import { receiveFromPartner, sendToPartner } from "@micfx/handoff";
import { putHandoff, takeHandoff } from "./inbox";

const status = document.querySelector(".status")!;
const say = (text: string) => { status.textContent = text; };
const params = new URLSearchParams(location.search);

async function send(id: string) {
  // The DAW renders the mix while this page waits for it.
  say("Getting the mix ready…");
  let payload;
  for (let i = 0; i < 600 && !(payload = await takeHandoff(`out-${id}`)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!payload) return say("Nothing came to send. Try again from MicFX DAW.");
  say("Opening MicFX Voice…");
  const button = document.querySelector<HTMLButtonElement>(".go")!;
  // Opening a window needs a click on this page (the DAW's click doesn't count here).
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.hidden = true;
    say("Sending to MicFX Voice…");
    const answer = await sendToPartner("daw", payload);
    say(answer.ok ? `Sent. ${answer.message ?? ""}`.trim() : answer.message ?? "Couldn't send it.");
    if (answer.ok) setTimeout(() => window.close(), 1500);
  }, { once: true });
  say(`Ready to send ${payload.title ?? "it"} to MicFX Voice.`);
}

const sendId = params.get("send");
if (sendId) void send(sendId.replace(/[^\w-]/g, ""));
else if (!receiveFromPartner("daw", async (payload) => {
  const id = `${Date.now()}`;
  await putHandoff(`in-${id}`, payload);
  say("Opening MicFX DAW…");
  setTimeout(() => location.replace(new URL(`./?inbox=${id}`, location.href).href), 100);
  return { ok: true, message: "MicFX DAW is opening with it." };
})) say("This page passes things between MicFX Voice and MicFX DAW. Nothing to do here.");
