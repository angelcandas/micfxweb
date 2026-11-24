// MicFX Voice: live voice effects in the browser. The audio engine and the reused
// desktop UI arrive in the next PRs (see docs/plan.md, section 7).
const app = document.querySelector<HTMLElement>("#app");
if (app) {
  app.innerHTML = `<h1>MicFX Voice</h1><p>Live voice effects in your browser. Coming soon.</p>`;
}
