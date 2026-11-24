// Desktop projects in and out of the browser (plan point 22). A desktop project is a folder
// "Name.micfx"; it comes in as that folder (picked on the computer) or as one ".micfxproj"
// file, and goes out as a .micfxproj download or, in Chrome and Edge, straight into a folder on
// the computer. The engine makes the desktop copy (packages/engine/cpp/daw/WebProject.cpp).
import { download, pickFromComputer } from "./chooser";
import type { DawEngine } from "./engine";

const LEFT_BEHIND = new Set(["Backups", "History", "Versions"]);
const PROJECTS = (engine: DawEngine) => `${engine.home}/Documents/MicFX Projects`;

interface Reply { ok: boolean; error?: string; folder?: string; path?: string; name?: string; files?: string[] }
const project = (engine: DawEngine, ...args: string[]) => engine.call("webProject", args) as Promise<Reply>;

/** Lets the person pick a project folder on the computer (every browser): its files. */
export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

/** Copies a desktop project folder (its files, as picked) into the browser: the project's path. */
export async function importFolder(engine: DawEngine, files: File[]): Promise<string> {
  const pathOf = (file: File) => (file as File & { webkitRelativePath: string }).webkitRelativePath || file.name;
  // project.xml at the top of what was picked, or one folder down (the parent was picked).
  const xml = files.map(pathOf).filter((p) => p.endsWith("/project.xml")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!xml) throw new Error("That folder isn't a MicFX project (it has no project.xml).");
  const root = xml.slice(0, -"project.xml".length);
  const folderName = root.split("/").filter(Boolean).pop() ?? "Project";
  const base = folderName.replace(/\.micfx$/i, "").replace(/[/\\]/g, "_") || "Project";

  const existing = new Set((await engine.list(PROJECTS(engine))).map((e) => e.name));
  let name = `${base}.micfx`;
  for (let n = 2; existing.has(name); n++) name = `${base} ${n}.micfx`;
  const target = `${PROJECTS(engine)}/${name}`;

  for (const file of files) {
    const path = pathOf(file);
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    if (LEFT_BEHIND.has(relative.split("/")[0]!) || relative.split("/").some((part) => part.startsWith("."))) continue;
    await engine.writeFile(`${target}/${relative}`, await file.arrayBuffer());
  }
  return target;
}

/** A .micfxproj (a zipped project folder) into the browser: the project's path. */
export async function importBundle(engine: DawEngine, file: File): Promise<string> {
  const path = `/tmp/micfx-in-${Date.now()}.zip`;
  await engine.writeFile(path, await file.arrayBuffer());
  const reply = await project(engine, "unpack", path);
  if (!reply.ok || !reply.folder) throw new Error(reply.error ?? `Couldn't open ${file.name}.`);
  return reply.folder;
}

/** Opens a project from the computer: a folder, or a .micfxproj file. */
export async function pickProject(engine: DawEngine, kind: "folder" | "bundle"): Promise<string | undefined> {
  if (kind === "folder") {
    const files = await pickFolder();
    return files.length ? importFolder(engine, files) : undefined;
  }
  const [file] = await pickFromComputer([".micfxproj", ".zip"], false);
  return file ? importBundle(engine, file) : undefined;
}

/** The project as one .micfxproj file, downloaded. */
export async function downloadProject(engine: DawEngine) {
  const reply = await project(engine, "pack");
  try {
    if (!reply.ok || !reply.path) throw new Error(reply.error ?? "Couldn't pack the project.");
    download(`${reply.name ?? "Project"}.micfxproj`, await engine.readFile(reply.path));
  } finally {
    await project(engine, "cleanup");
  }
}

export const canSaveToFolder = () => "showDirectoryPicker" in window;

type DirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(data: ArrayBuffer): Promise<void>; close(): Promise<void> }> }>;
};

/** Chrome and Edge: the project as a desktop project folder, in a folder the person picks. */
export async function saveToFolder(engine: DawEngine): Promise<string | undefined> {
  const picker = (window as unknown as { showDirectoryPicker(options: object): Promise<DirectoryHandle> }).showDirectoryPicker;
  let parent: DirectoryHandle;
  try {
    parent = await picker.call(window, { id: "micfx-projects", mode: "readwrite", startIn: "documents" });
  } catch {
    return undefined; // cancelled
  }
  const reply = await project(engine, "stage");
  try {
    if (!reply.ok || !reply.folder || !reply.files) throw new Error(reply.error ?? "Couldn't copy the project.");
    const folderName = `${reply.name ?? "Project"}.micfx`;
    const top = await parent.getDirectoryHandle(folderName, { create: true });
    for (const relative of reply.files) {
      const parts = relative.split("/");
      let dir = top;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
      await writable.write(await engine.readFile(`${reply.folder}/${relative}`));
      await writable.close();
    }
    return folderName;
  } finally {
    await project(engine, "cleanup");
  }
}
