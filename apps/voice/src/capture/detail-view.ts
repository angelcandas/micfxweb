import { findMelody } from "../analysis-client";
import { engineModule } from "./analyze";
import { fileName, shareFile, shareIdea } from "./actions";
import { BEAT_STYLES, renderBeat, type BeatStyle } from "./beat";
import { drawBars, el, formatTime, sheet, toast, type Child } from "./dom";
import { PlayAlong, parseKey } from "./playalong";
import { saveSamples, mixDown, resample } from "./make-idea";
import { notesToMidi, parseMelody, type Note } from "./midi";
import PolishWorker from "./polish-worker?worker";
import SoundWorker from "./sound-worker?worker";
import type { SoundReply } from "./sound-worker";
import type { PolishReply } from "./polish-worker";
import { isPhone, sendToDaw, shareZip } from "./transfer";
import { getIdea, readAudio, saveIdea, type Idea } from "./store";
import { readSamples } from "./wav";

export interface DetailHooks {
  /** The list should reload. */
  changed(): void;
  /** Record a new take over this idea. */
  layer(idea: Idea): void;
  remove(idea: Idea): void;
  open(idea: Idea): void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

/** One idea, full screen: play it (slower, looped), write on it, and the things to do with it. */
export function openDetail(start: Idea, hooks: DetailHooks): void {
  let idea = start;
  const dialog = el("dialog", { class: "detail", "aria-label": idea.name });
  const canvas = el("canvas", { class: "detail-wave", role: "slider", "aria-label": "Position", tabIndex: 0 });
  const time = el("div", { class: "detail-time", role: "timer" }, `0:00.0 / ${formatTime(idea.length)}`);
  const play = el("button", { type: "button", class: "idea-play detail-play", "aria-label": "Play" }, "▶");
  const loopButton = el("button", { type: "button", class: "chip", "aria-pressed": "false" }, "Loop");
  const speed = el("div", { class: "filters", role: "group", "aria-label": "Speed" });
  const name = el("input", { type: "text", class: "search", value: idea.name, maxLength: 80, "aria-label": "Name" });
  const note = el("textarea", { class: "search detail-note", placeholder: "A note: words, a chord, where it goes…", maxLength: 600, rows: 3, "aria-label": "Note" }, idea.note);
  const key = el("input", { type: "text", class: "search", value: idea.key ?? "", placeholder: "Key", maxLength: 12, "aria-label": "Key" });
  const bpm = el("input", { type: "number", class: "search", value: idea.bpm ? String(idea.bpm) : "", placeholder: "BPM", min: "30", max: "300", inputMode: "numeric", "aria-label": "Tempo in BPM" });
  const status = el("div", { class: "rec-hint", "aria-live": "polite" });
  const notesBox = el("div", { class: "detail-notes", hidden: true });

  const audio = new Audio();
  audio.preservesPitch = true;
  const along = new PlayAlong();
  along.bpm = idea.bpm ?? 100;
  along.key = parseKey(idea.key);
  let url = "";
  let loop: { a?: number; b?: number; on: boolean } = { on: false };
  let raf = 0;

  void readAudio(idea).then((blob) => { url = URL.createObjectURL(blob); audio.src = url; });

  const paint = () => {
    const at = audio.currentTime;
    drawBars(canvas, idea.peaks, { played: at / Math.max(0.1, idea.length) });
    const ctx = canvas.getContext("2d")!;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x = (s: number) => (s / Math.max(0.1, idea.length)) * w;
    ctx.fillStyle = "rgba(255, 212, 121, 0.9)";
    for (const m of idea.markers) { ctx.fillRect(x(m) - 1, 0, 2, h); ctx.fillRect(x(m) - 1, 0, 8, 6); }
    if (loop.a !== undefined) {
      ctx.fillStyle = "rgba(63, 217, 198, 0.22)";
      const b = loop.b ?? idea.length;
      ctx.fillRect(x(loop.a), 0, Math.max(2, x(b) - x(loop.a)), h);
    }
    time.textContent = `${formatTime(at)} / ${formatTime(idea.length)}`;
    play.textContent = audio.paused ? "▶" : "❚❚";
    play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  };
  const tick = () => {
    if (loop.on && loop.a !== undefined && audio.currentTime >= (loop.b ?? idea.length) - 0.02) audio.currentTime = loop.a;
    along.tick(audio.currentTime, audio.playbackRate);
    paint();
    raf = audio.paused ? 0 : requestAnimationFrame(tick);
  };
  audio.addEventListener("play", () => { along.seek(audio.currentTime); along.syncDrone(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  audio.addEventListener("pause", () => { along.syncDrone(false); paint(); });
  audio.addEventListener("seeked", () => along.seek(audio.currentTime));
  audio.addEventListener("ended", () => { along.syncDrone(false); audio.currentTime = 0; paint(); });
  play.addEventListener("click", () => void (audio.paused ? audio.play() : audio.pause()));
  const seek = (clientX: number) => {
    const rect = canvas.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(idea.length, ((clientX - rect.left) / rect.width) * idea.length));
    paint();
  };
  canvas.addEventListener("pointerdown", (event) => seek(event.clientX));
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") audio.currentTime = Math.min(idea.length, audio.currentTime + 2);
    if (event.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 2);
    paint();
  });

  // Loop: the first tap sets the start where the play head is, the second the end, the third clears it.
  loopButton.addEventListener("click", () => {
    if (loop.a === undefined) loop = { a: audio.currentTime, on: false };
    else if (loop.b === undefined) loop = { ...loop, b: Math.max(loop.a + 0.3, audio.currentTime), on: true };
    else loop = { on: false };
    loopButton.setAttribute("aria-pressed", String(loop.on));
    loopButton.textContent = loop.a === undefined ? "Loop" : loop.b === undefined ? `From ${formatTime(loop.a, false)}: set the end` : `Loop ${formatTime(loop.a, false)}–${formatTime(loop.b, false)}`;
    if (loop.on && loop.a !== undefined) { audio.currentTime = loop.a; void audio.play(); }
    paint();
  });

  for (const s of SPEEDS) {
    speed.append(el("button", { type: "button", class: "chip", "aria-pressed": String(s === 1), onclick: () => {
      audio.playbackRate = s;
      speed.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(SPEEDS[i] === s)));
    } }, `${s}×`));
  }

  async function save(changes: Partial<Idea>) {
    idea = { ...((await getIdea(idea.id)) ?? idea), ...changes };
    await saveIdea(idea);
    hooks.changed();
  }
  name.addEventListener("change", () => void save({ name: name.value.trim() || idea.name }));
  note.addEventListener("change", () => void save({ note: note.value.trim() }));
  key.addEventListener("change", () => { along.key = parseKey(key.value); if (audio.paused === false) along.syncDrone(true); void save({ key: key.value.trim() || undefined }); });
  bpm.addEventListener("change", () => { along.bpm = Number(bpm.value) > 0 ? Number(bpm.value) : 100; along.seek(audio.currentTime); void save({ bpm: Number(bpm.value) > 0 ? Math.round(Number(bpm.value)) : undefined }); });

  // Play along: a click at the tempo, a quiet drone on the key.
  const clickChip = el("button", { type: "button", class: "chip", "aria-pressed": "false", onclick: () => {
    along.clickOn = !along.clickOn;
    clickChip.setAttribute("aria-pressed", String(along.clickOn));
    along.seek(audio.currentTime);
  } }, "Click");
  const droneChip = el("button", { type: "button", class: "chip", "aria-pressed": "false", onclick: () => {
    if (!along.key) { status.textContent = "Set the key above first (for example A minor), then the drone can play it."; return; }
    status.textContent = "";
    along.setDrone(!along.droneOn);
    droneChip.setAttribute("aria-pressed", String(along.droneOn));
    along.syncDrone(!audio.paused);
  } }, "Drone");

  // Mark: add a marker at the play head.
  const markButton = el("button", { type: "button", class: "chip", onclick: () => {
    const at = Math.round(audio.currentTime * 10) / 10;
    void save({ markers: [...new Set([...idea.markers, at])].sort((a, b) => a - b) }).then(paint);
  } }, "Mark here");

  const busy = (message: string) => { status.textContent = message; };

  async function polish() {
    busy("Cleaning up the sound…");
    try {
      const { samples, rate } = readSamples(await (await readAudio(idea)).arrayBuffer());
      const module = await engineModule();
      const worker = new PolishWorker();
      const reply = await new Promise<PolishReply>((resolve) => {
        worker.onmessage = (event: MessageEvent<PolishReply>) => resolve(event.data);
        worker.onerror = () => resolve({ error: "the clean-up stopped" });
        worker.postMessage({ module, samples, rate }, [samples.buffer]);
      });
      worker.terminate();
      if ("error" in reply) throw new Error(reply.error);
      const made = await saveSamples(reply.samples, rate, { name: `${idea.name} · polished`, note: idea.note, parent: idea.id, key: idea.key, bpm: idea.bpm });
      busy("");
      hooks.changed();
      toast("Saved a polished copy. Your original is untouched.", { label: "Open", run: () => { close(); hooks.open(made); } });
    } catch (error) {
      busy(`Couldn't polish it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  // Try a sound: the idea through one of the Live screen's factory sounds, heard first and kept if wanted.
  function askSound(request: Record<string, unknown>, transfer: Transferable[] = []) {
    const worker = new SoundWorker();
    return new Promise<SoundReply>((resolve) => {
      worker.onmessage = (event: MessageEvent<SoundReply>) => { worker.terminate(); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); resolve({ error: "the effects stopped" }); };
      worker.postMessage(request, transfer);
    });
  }

  async function chooseSound() {
    busy("Loading the sounds…");
    try {
      const reply = await askSound({ kind: "list", module: await engineModule() });
      busy("");
      if (!("presets" in reply)) throw new Error("error" in reply ? reply.error : "no sounds");
      const rows: Child[] = [];
      let category = "";
      reply.presets.forEach((preset, index) => {
        if (preset.category !== category) {
          category = preset.category;
          rows.push(el("h3", { class: "sheet-group" }, category));
        }
        rows.push(el("button", { type: "button", class: "sheet-row", onclick: () => { picker.close(); void hearSound(index, preset.name); } }, el("span", {}, preset.name), el("span", {}, "›")));
      });
      const picker = sheet("Try a sound", el("div", { class: "sheet-list" }, ...rows),
        el("p", { class: "sheet-note" }, "Your idea through one of the Live screen's sounds. You hear it first and keep it only if you like it."));
    } catch (error) {
      busy(`Couldn't load the sounds: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function hearSound(preset: number, label: string) {
    busy(`Trying ${label}…`);
    try {
      const { samples, rate } = readSamples(await (await readAudio(idea)).arrayBuffer());
      const reply = await askSound({ kind: "render", module: await engineModule(), samples, rate, preset }, [samples.buffer]);
      if (!("samples" in reply)) throw new Error("error" in reply ? reply.error : "nothing came back");
      busy("");
      audio.pause();
      const context = new AudioContext();
      const buffer = context.createBuffer(1, reply.samples.length, rate);
      buffer.copyToChannel(new Float32Array(reply.samples), 0);
      let source: AudioBufferSourceNode | undefined;
      const status2 = el("p", { class: "sheet-note" }, "Playing…");
      const stop = () => { try { source?.stop(); } catch { /* already over */ } };
      const play = () => {
        stop();
        void context.resume();
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => { status2.textContent = "Done. Play it again, keep it, or go back and try another."; };
        status2.textContent = "Playing…";
        source.start();
      };
      const preview = sheet(`${label}`, status2,
        el("div", { class: "sheet-list" },
          el("button", { type: "button", class: "sheet-row", onclick: play }, el("span", {}, "Play again"), el("span", {}, "▶")),
          el("button", { type: "button", class: "sheet-row", onclick: async () => {
            const made = await saveSamples(reply.samples, rate, { name: `${idea.name} · ${label}`, note: idea.note, parent: idea.id, key: idea.key, bpm: idea.bpm });
            preview.close();
            hooks.changed();
            toast(`Kept as a new idea. Your original is untouched.`, { label: "Open", run: () => { close(); hooks.open(made); } });
          } }, el("span", {}, "Keep as a new idea"), el("span", {}, "＋")),
          el("button", { type: "button", class: "sheet-row", onclick: () => { preview.close(); void chooseSound(); } }, el("span", {}, "Try another sound"), el("span", {}, "›"))));
      preview.addEventListener("close", () => { stop(); void context.close(); });
      play();
    } catch (error) {
      busy(`Couldn't try ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function findNotes() {
    busy("Listening for the melody…");
    try {
      const { samples, rate } = readSamples(await (await readAudio(idea)).arrayBuffer());
      const { melody } = await findMelody(samples, rate);
      const notes = parseMelody(melody);
      busy(notes.length ? "" : "No clear melody found: try a steadier hum or a clearer note.");
      if (!notes.length) return;
      showNotes(notes);
    } catch (error) {
      busy(`Couldn't find the notes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function showNotes(notes: Note[]) {
    const strip = el("canvas", { class: "detail-roll", "aria-label": `${notes.length} notes found`, role: "img" });
    notesBox.hidden = false;
    notesBox.replaceChildren(el("div", { class: "idea-meta" }, el("b", {}, `${notes.length} notes`)), strip,
      el("div", { class: "rec-toggles", style: "justify-content:flex-start" },
        el("button", { type: "button", class: "chip", onclick: () => {
          const bytes = notesToMidi(notes, idea.bpm ?? 120);
          void shareFile(new File([bytes as BlobPart], fileName(idea, "mid"), { type: "audio/midi" }), idea.name);
        } }, "Save as MIDI"),
        el("span", { class: "sheet-note" }, `Plays at ${idea.bpm ?? 120} BPM; set the tempo above to change it.`)));
    requestAnimationFrame(() => {
      const w = strip.clientWidth, h = strip.clientHeight;
      strip.width = w * devicePixelRatio; strip.height = h * devicePixelRatio;
      const ctx = strip.getContext("2d")!;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      const lo = Math.min(...notes.map((n) => n.pitch)) - 1, hi = Math.max(...notes.map((n) => n.pitch)) + 1;
      const end = Math.max(...notes.map((n) => n.end));
      ctx.fillStyle = "#8c7bff";
      for (const n of notes) ctx.fillRect((n.start / end) * w, h - ((n.pitch - lo) / (hi - lo)) * h - 3, Math.max(3, ((n.end - n.start) / end) * w), 6);
    });
  }

  function chooseBeat() {
    const dialog = sheet("Add a beat", el("div", { class: "sheet-list" },
      ...BEAT_STYLES.map((style) => el("button", { type: "button", class: "sheet-row", onclick: () => { dialog.close(); void addBeat(style); } }, style))),
      el("p", { class: "sheet-note" }, `At ${idea.bpm ?? 100} BPM, from the start of the idea. Set the tempo above first if it's wrong. Saved as a new idea.`));
  }

  async function addBeat(style: BeatStyle) {
    busy("Adding the beat…");
    const { samples, rate } = readSamples(await (await readAudio(idea)).arrayBuffer());
    const tempo = idea.bpm ?? 100;
    const beat = renderBeat(style, tempo, samples.length / rate + 0.1, rate).map((v) => v * 0.55);
    const made = await saveSamples(mixDown(samples, beat, 0, rate), rate, { name: `${idea.name} + ${style.toLowerCase()} beat`, key: idea.key, bpm: tempo, parent: idea.id });
    busy("");
    hooks.changed();
    toast("Saved with the beat as a new idea.", { label: "Open", run: () => { close(); hooks.open(made); } });
  }

  async function mixWithParent() {
    if (!idea.parent) return;
    const parent = await getIdea(idea.parent);
    if (!parent) return busy("The idea this was layered over is gone.");
    busy("Mixing…");
    const under = readSamples(await (await readAudio(parent)).arrayBuffer());
    const over = readSamples(await (await readAudio(idea)).arrayBuffer());
    const mixed = mixDown(under.samples, resample(over.samples, over.rate, under.rate), idea.offset ?? 0, under.rate);
    const made = await saveSamples(mixed, under.rate, { name: `${parent.name} + layer`, key: parent.key, bpm: parent.bpm });
    busy("");
    hooks.changed();
    toast("Mixed into a new idea.", { label: "Open", run: () => { close(); hooks.open(made); } });
  }

  const action = (label: string, hint: string, run: () => void, danger = false) =>
    el("button", { type: "button", class: `sheet-row${danger ? " danger" : ""}`, onclick: run }, el("span", {}, el("div", {}, label), el("small", { class: "sheet-note", style: "margin:0" }, hint)), el("span", {}, "›"));

  function close() {
    cancelAnimationFrame(raf);
    along.close();
    audio.pause();
    if (url) URL.revokeObjectURL(url);
    dialog.close();
    dialog.remove();
    hooks.changed();
  }

  dialog.append(
    el("div", { class: "cap-top" }, el("button", { type: "button", class: "icon-btn", "aria-label": "Back", onclick: close }, "‹"), el("h1", {}, "Idea"),
      el("button", { type: "button", class: "icon-btn", "aria-label": idea.starred ? "Remove the star" : "Star", onclick: async (event: Event) => {
        await save({ starred: !idea.starred });
        (event.currentTarget as HTMLElement).textContent = idea.starred ? "★" : "☆";
      } }, idea.starred ? "★" : "☆")),
    el("div", { class: "detail-body" },
      name, canvas, time,
      el("div", { class: "rec-actions", style: "gap:20px" }, play),
      el("div", { class: "rec-toggles" }, markButton, loopButton, clickChip, droneChip),
      speed,
      el("div", { class: "detail-two" }, key, bpm),
      note, status, notesBox,
      el("div", { class: "sheet-list" },
        action("Layer another take on top", "Plays this while you record, so use headphones", () => { close(); hooks.layer(idea); }),
        idea.parent ? action("Mix with the idea underneath", "Makes one new idea out of the two", () => void mixWithParent()) : null,
        action("Try a sound", "Hear this idea through the Live screen's sounds: radio, studio, and more", () => void chooseSound()),
        action("Make it sound good", "Clean-up, level and a touch of room, as a new copy", () => void polish()),
        action("Add a beat", "A scratch drum pattern at the idea's tempo, as a new idea", chooseBeat),
        action("Turn the melody into notes", "Hum a tune, get notes and a MIDI file", () => void findNotes()),
        isPhone() ? null : action("Send to MicFX DAW", "Opens the DAW with this as a track", () => void sendToDaw([idea]).then((a) => toast(a.message ?? (a.ok ? "Sent to MicFX DAW." : "MicFX DAW didn't take it.")))),
        action(isPhone() ? "Save for the computer" : "Share or save the audio", isPhone() ? "Share the file by AirDrop, Files or a cable, then open it in MicFX DAW" : "WAV file", () => void shareZip([idea])),
        action("Delete", "You can undo for a few seconds", () => { close(); hooks.remove(idea); }, true))));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  requestAnimationFrame(paint);
}
