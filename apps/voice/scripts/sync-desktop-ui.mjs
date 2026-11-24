// Copies the desktop app's UI (extern/local-mic-effects/ui) into public/desktop, where the
// Voice app serves it as is. Generated: not committed. Runs before dev and build.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../extern/local-mic-effects/ui/", import.meta.url));
const to = fileURLToPath(new URL("../public/desktop/", import.meta.url));

if (!existsSync(from)) {
  console.error("The desktop UI is missing: run 'pnpm deps' first.");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") });
console.log("Desktop UI copied to public/desktop");
