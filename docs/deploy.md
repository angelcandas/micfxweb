# Deploying

MicFX Voice is deployed to **Cloudflare Pages** by CI (`.github/workflows/ci.yml`, job
"Deploy MicFX Voice") after every push to `main` that passes the tests. MicFX DAW
deploys the same way (job "Deploy MicFX DAW") to its own Pages project.

| App | Pages project | Domain |
| --- | --- | --- |
| MicFX Voice | `micfxvoice` | `micfxvoice.sobrinotech.<tld>` |
| MicFX DAW | `micfxdaw` | `micfxdaw.sobrinotech.<tld>` |

Everything is static. There is no server: settings, sounds, tracks and projects stay in the
visitor's browser (localStorage, IndexedDB, and for the DAW the origin private file system).
Voice needs no COOP/COEP headers (its engine doesn't use SharedArrayBuffer). The DAW does:
its engine runs the desktop DAW on threads, so `apps/daw/public/_headers` serves every page
with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

## One-time setup

1. In Cloudflare, create an API token (My Profile → API Tokens → Create token → Custom)
   with the **Account · Cloudflare Pages · Edit** permission.
2. In GitHub, go to micfxweb → Settings → Secrets and variables → Actions and add:
   - secret `CLOUDFLARE_API_TOKEN`: the token
   - secret `CLOUDFLARE_ACCOUNT_ID`: the account ID (shown on the Cloudflare dashboard's
     overview, right column)
   - variable `VOICE_DOMAIN` (optional): for example `micfxvoice.sobrinotech.com`. Without it, the deploy uses `micfxvoice.<zone>` for a `sobrinotech.*` zone the token can see (Zone: Read), and adds its DNS record (Zone: DNS: Edit)
   - variable `DAW_DOMAIN` (optional): the same for the DAW (default `micfxdaw.<zone>`)
3. Re-run the CI workflow on `main`, or push to it.

The first deploy creates the `micfxvoice` Pages project. It then attaches `VOICE_DOMAIN`.
When the domain's DNS is on Cloudflare, Pages adds the CNAME record itself. Otherwise, add
a CNAME from the subdomain to `micfxvoice.pages.dev` at your DNS host.

Until the secrets are set, the deploy job only prints a notice and passes.
