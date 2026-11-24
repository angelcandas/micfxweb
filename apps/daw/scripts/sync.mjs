// Copies what MicFX DAW serves as is, before dev and build (generated: not committed):
// - the desktop app's UI (extern/local-mic-effects/ui) to public/desktop
// - the DAW engine (packages/engine/dist/daw.mjs + daw.wasm, built by build-daw.sh) to
//   public/engine. Emscripten's glue starts its threads from its own URL, so it is served
//   beside its wasm rather than bundled.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const ui = at("../../../extern/local-mic-effects/ui/");
const engine = at("../../../packages/engine/dist/");

if (!existsSync(ui)) {
  console.error("The desktop UI is missing: run 'pnpm deps' first.");
  process.exit(1);
}
if (!existsSync(`${engine}daw.wasm`)) {
  console.error("daw.wasm is missing: run 'pnpm --filter @micfx/engine build:daw' first.");
  process.exit(1);
}
rmSync(at("../public/desktop/"), { recursive: true, force: true });
cpSync(ui, at("../public/desktop/"), { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") });
rmSync(at("../public/engine/"), { recursive: true, force: true });
mkdirSync(at("../public/engine/"));
for (const file of ["daw.mjs", "daw.wasm"]) cpSync(`${engine}${file}`, at(`../public/engine/${file}`));
console.log("Desktop UI and the DAW engine copied to public/");
