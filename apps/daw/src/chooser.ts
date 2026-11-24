// The desktop's file choosers on the web. Everything the DAW opens and saves lives in the
// browser's private storage (the engine's home folder); files from the computer are copied
// in first, and what the DAW exports is downloaded.
import type { DawEngine } from "./engine";
import type { ChooserRequest, FileEntry } from "./protocol";

const extensions = (patterns: string) =>
  patterns.split(/[;,\s]+/).map((p) => p.trim().replace(/^\*/, "")).filter((p) => p.startsWith("."));

const parentOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Copies files from the computer into the browser's storage: their paths there. */
export async function importFiles(engine: DawEngine, files: File[], folder = `${engine.home}/Music/Imported`): Promise<string[]> {
  const existing = new Set((await engine.list(folder)).map((e) => e.name));
  const paths: string[] = [];
  for (const file of files) {
    let name = file.name.replace(/[/\\]/g, "_");
    const dot = name.lastIndexOf(".");
    for (let n = 2; existing.has(name); n++) name = dot > 0 ? `${file.name.slice(0, dot)} ${n}${file.name.slice(dot)}` : `${file.name} ${n}`;
    existing.add(name);
    await engine.writeFile(`${folder}/${name}`, await file.arrayBuffer());
    paths.push(`${folder}/${name}`);
  }
  return paths;
}

/** Lets the person pick files on their computer (input type=file). */
export function pickFromComputer(accept: string[], multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = el("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept.length) input.accept = accept.join(",");
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

export function download(name: string, data: ArrayBuffer | Blob) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Answers the engine's file choosers. */
export function createChooser(engine: DawEngine) {
  return async (request: ChooserRequest): Promise<string[]> => {
    return storageDialog(engine, request);
  };
}

/** A small file browser over the browser's storage, with "From your computer…" for opening. */
function storageDialog(engine: DawEngine, request: ChooserRequest): Promise<string[]> {
  return new Promise((resolve) => {
    const startIsFolder = !request.save && request.folders;
    let folder = request.start ? (request.save || !startIsFolder ? parentOf(request.start) : request.start) : engine.home;
    if (!folder.startsWith(engine.home)) folder = engine.home;
    let selected: FileEntry | undefined;

    const backdrop = el("div", "web-dialog-backdrop");
    const dialog = el("div", "web-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", request.title);
    const title = el("h2", "web-dialog-title", request.title || (request.save ? "Save" : "Open"));
    const where = el("div", "web-dialog-where");
    const list = el("div", "web-dialog-list");
    list.setAttribute("role", "listbox");
    const nameRow = el("label", "web-dialog-name");
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.value = request.save ? nameOf(request.start) || "Untitled" : "";
    nameRow.append(el("span", "", "Name"), nameInput);
    nameRow.hidden = !request.save;
    const note = el("p", "web-dialog-note",
      engine.persistent ? "Kept in this browser's storage on this computer." : "This browser can't keep files: they last until you close the tab.");
    const buttons = el("div", "web-dialog-buttons");
    const fromComputer = el("button", "web-dialog-secondary", "From your computer…");
    fromComputer.type = "button";
    fromComputer.hidden = request.save || (request.folders && !request.files);
    const newFolder = el("button", "web-dialog-secondary", "New folder");
    newFolder.type = "button";
    newFolder.hidden = !request.save && !request.folders;
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const ok = el("button", "web-dialog-primary", request.save ? "Save" : "Open");
    ok.type = "button";
    buttons.append(fromComputer, newFolder, el("span", "web-dialog-gap"), cancel, ok);
    dialog.append(title, where, list, nameRow, note, buttons);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const wanted = extensions(request.patterns);
    const matches = (entry: FileEntry) => entry.folder || wanted.length === 0 || wanted.some((x) => entry.name.toLowerCase().endsWith(x.toLowerCase()));

    const finish = (paths: string[]) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(paths);
    };

    const render = async () => {
      const entries = (await engine.list(folder)).filter((e) => !e.name.startsWith(".") && matches(e))
        .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      where.replaceChildren();
      const parts = folder.slice(engine.home.length).split("/").filter(Boolean);
      const crumb = (label: string, path: string) => {
        const b = el("button", "web-dialog-crumb", label);
        b.type = "button";
        b.addEventListener("click", () => { folder = path; selected = undefined; void render(); });
        return b;
      };
      where.append(crumb("Browser storage", engine.home));
      parts.forEach((part, i) => where.append(" / ", crumb(part, `${engine.home}/${parts.slice(0, i + 1).join("/")}`)));
      list.replaceChildren(...(entries.length ? entries.map((entry) => {
        const row = el("button", "web-dialog-row" + (entry.folder ? " is-folder" : ""));
        row.type = "button";
        row.setAttribute("role", "option");
        row.append(el("span", "web-dialog-icon", entry.folder ? "📁" : "🎵"), el("span", "web-dialog-file", entry.name),
          el("span", "web-dialog-size", entry.folder ? "" : `${Math.max(1, Math.round(entry.size / 1024))} KB`));
        row.addEventListener("click", () => {
          selected = entry;
          for (const other of list.children) other.classList.toggle("is-selected", other === row);
          if (request.save && !entry.folder) nameInput.value = entry.name;
        });
        row.addEventListener("dblclick", () => {
          if (entry.folder) { folder = `${folder}/${entry.name}`; selected = undefined; void render(); }
          else confirm();
        });
        return row;
      }) : [el("div", "web-dialog-empty", request.save ? "Nothing here yet." : "Nothing here yet. Use “From your computer…” to bring files in.")]));
    };

    const confirm = () => {
      if (request.save) {
        const name = nameInput.value.trim().replace(/[/\\]/g, "_");
        if (!name) { nameInput.focus(); return; }
        finish([`${folder}/${name}`]);
      } else if (selected) {
        if (selected.folder && !request.folders) { folder = `${folder}/${selected.name}`; selected = undefined; void render(); return; }
        finish([`${folder}/${selected.name}`]);
      } else if (request.folders) finish([folder]);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); finish([]); }
      else if (event.key === "Enter") { event.stopPropagation(); event.preventDefault(); confirm(); }
    };
    document.addEventListener("keydown", onKey, true);
    ok.addEventListener("click", confirm);
    cancel.addEventListener("click", () => finish([]));
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish([]); });
    newFolder.addEventListener("click", async () => {
      const name = window.prompt("Folder name", "New folder")?.trim().replace(/[/\\]/g, "_");
      if (!name) return;
      await engine.mkdir(`${folder}/${name}`);
      folder = `${folder}/${name}`;
      void render();
    });
    fromComputer.addEventListener("click", async () => {
      const files = await pickFromComputer(wanted, request.multiple);
      if (files.length) finish(await importFiles(engine, files));
    });

    void engine.mkdir(folder).then(render);
    (request.save ? nameInput : ok).focus();
    if (request.save) nameInput.select();
  });
}
