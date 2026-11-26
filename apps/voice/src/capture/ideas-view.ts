import { drawBars, el, formatTime, sheet, toast } from "./dom";
import { deleteIdea, listIdeas, readAudio, saveIdea, type Idea } from "./store";

type Filter = "all" | "starred" | "today";

/** The Ideas screen: newest first, tap to play. */
export function ideasView(openRecord: () => void): { root: HTMLElement; reload(): Promise<void>; stopPlaying(): void } {
  const root = el("section", { class: "ideas", "aria-label": "Ideas" });
  const search = el("input", { type: "search", class: "search", placeholder: "Search ideas", "aria-label": "Search ideas", oninput: () => render() });
  const filters = el("div", { class: "filters", role: "group", "aria-label": "Filter" });
  const list = el("div", { class: "idea-list", style: "display:flex;flex-direction:column;gap:10px" });
  root.append(el("div", { class: "ideas-tools" }, search, filters), list);

  let ideas: Idea[] = [];
  let filter: Filter = "all";
  let playing: { id: string; audio: HTMLAudioElement; url: string } | undefined;

  for (const [id, label] of [["all", "All"], ["starred", "Starred"], ["today", "Today"]] as const) {
    const chip = el("button", { type: "button", class: "chip", "aria-pressed": String(id === filter), onclick: () => {
      filter = id;
      filters.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(["all", "starred", "today"][i] === filter)));
      render();
    } }, label);
    filters.append(chip);
  }

  async function reload() {
    ideas = (await listIdeas()).filter((i) => !i.deleted && i.status !== "recording").sort((a, b) => b.created - a.created);
    render();
  }

  function visible(): Idea[] {
    const q = search.value.trim().toLowerCase();
    const midnight = new Date().setHours(0, 0, 0, 0);
    return ideas.filter((i) =>
      (filter === "all" || (filter === "starred" && i.starred) || (filter === "today" && i.created >= midnight))
      && (!q || `${i.name} ${i.note} ${i.key ?? ""}`.toLowerCase().includes(q)));
  }

  function stopPlaying() {
    if (!playing) return;
    playing.audio.pause();
    URL.revokeObjectURL(playing.url);
    playing = undefined;
    render();
  }

  async function toggle(idea: Idea) {
    if (playing?.id === idea.id) return playing.audio.paused ? void playing.audio.play() : playing.audio.pause();
    stopPlaying();
    const url = URL.createObjectURL(await readAudio(idea));
    const audio = new Audio(url);
    playing = { id: idea.id, audio, url };
    audio.addEventListener("ended", () => { audio.currentTime = 0; render(); });
    audio.addEventListener("pause", () => render());
    audio.addEventListener("play", () => { render(); tick(); });
    await audio.play().catch(() => {});
  }

  function tick() {
    if (!playing || playing.audio.paused) return;
    const canvas = list.querySelector<HTMLCanvasElement>(`[data-id="${playing.id}"] canvas`);
    const idea = ideas.find((i) => i.id === playing!.id);
    if (canvas && idea) drawBars(canvas, idea.peaks, { played: playing.audio.currentTime / Math.max(0.1, idea.length) });
    requestAnimationFrame(tick);
  }

  async function update(idea: Idea, changes: Partial<Idea>) {
    const next = { ...idea, ...changes };
    await saveIdea(next);
    ideas = ideas.map((i) => (i.id === idea.id ? next : i));
    render();
  }

  function remove(idea: Idea) {
    if (playing?.id === idea.id) stopPlaying();
    void saveIdea({ ...idea, deleted: Date.now() });
    ideas = ideas.filter((i) => i.id !== idea.id);
    render();
    let undone = false;
    toast(`Deleted “${idea.name}”`, { label: "Undo", run: () => { undone = true; void saveIdea(idea).then(reload); } }, 10000);
    setTimeout(() => { if (!undone) void deleteIdea(idea.id); }, 10500);
  }

  async function share(idea: Idea) {
    const blob = await readAudio(idea);
    const file = new File([blob], `${idea.name.replace(/[^\w .-]+/g, "_")}.wav`, { type: "audio/wav" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: idea.name }); return; } catch (error) { if ((error as DOMException).name === "AbortError") return; }
    }
    const url = URL.createObjectURL(file);
    el("a", { href: url, download: file.name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function menu(idea: Idea) {
    const dialog = sheet(idea.name,
      el("div", { class: "sheet-list" },
        row("Rename", () => { dialog.close(); rename(idea); }),
        row(idea.starred ? "Remove the star" : "Star", () => { dialog.close(); void update(idea, { starred: !idea.starred }); }),
        row("Share or save the audio", () => { dialog.close(); void share(idea); }),
        row("Delete", () => { dialog.close(); remove(idea); }, true)));
  }
  const row = (label: string, run: () => void, danger = false) => el("button", { type: "button", class: `sheet-row${danger ? " danger" : ""}`, onclick: run }, label);

  function rename(idea: Idea) {
    const input = el("input", { type: "text", value: idea.name, maxLength: 80, "aria-label": "Name", style: "width:100%;max-width:100%" });
    const note = el("input", { type: "text", value: idea.note, placeholder: "A note", maxLength: 300, "aria-label": "Note", style: "width:100%;max-width:100%;margin-top:8px" });
    const dialog = sheet("Rename", input, note, el("button", { type: "button", class: "chip", style: "margin-top:12px", onclick: () => {
      dialog.close();
      void update(idea, { name: input.value.trim() || idea.name, note: note.value.trim() });
    } }, "Save"));
  }

  function card(idea: Idea): HTMLElement {
    const isPlaying = playing?.id === idea.id;
    const canvas = el("canvas", { class: "idea-wave", "aria-hidden": "true" });
    requestAnimationFrame(() => drawBars(canvas, idea.peaks, { played: isPlaying ? playing!.audio.currentTime / Math.max(0.1, idea.length) : undefined }));
    const date = new Date(idea.created).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return el("article", { class: `idea${isPlaying ? " is-playing" : ""}`, "data-id": idea.id },
      el("button", { type: "button", class: "idea-play", "aria-label": `${isPlaying && !playing!.audio.paused ? "Pause" : "Play"} ${idea.name}`, onclick: () => void toggle(idea) }, isPlaying && !playing!.audio.paused ? "❚❚" : "▶"),
      el("div", { class: "idea-body" },
        el("button", { type: "button", class: "idea-name", onclick: () => rename(idea) }, `${idea.starred ? "★ " : ""}${idea.name}`),
        el("div", { class: "idea-meta" }, el("span", {}, `${date} · ${formatTime(idea.length, false)}`),
          idea.key ? el("span", { class: "tag" }, idea.key) : null, idea.bpm ? el("span", { class: "tag" }, `${idea.bpm} BPM`) : null,
          idea.status === "recovered" ? el("span", { class: "tag warn" }, "Recovered") : null,
          idea.interrupted ? el("span", { class: "tag warn" }, "Stopped early") : null,
          idea.note ? el("span", {}, `· ${idea.note}`) : null)),
      el("button", { type: "button", class: "icon-btn idea-menu", "aria-label": `More for ${idea.name}`, onclick: () => menu(idea) }, "⋯"),
      canvas);
  }

  function render() {
    const shown = visible();
    list.replaceChildren(...shown.map(card));
    if (!ideas.length) {
      list.replaceChildren(el("div", { class: "empty" }, el("div", {}, "Your ideas will be here. Catch the first one."), el("button", { type: "button", class: "chip", onclick: openRecord }, "Record")));
    } else if (!shown.length) list.replaceChildren(el("div", { class: "empty" }, "No idea matches."));
  }

  return { root, reload, stopPlaying };
}
