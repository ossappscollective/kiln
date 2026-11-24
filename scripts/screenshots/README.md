# Screenshot tool

Generates the README and website screenshots from the demo (`pnpm demo`) with Playwright: 1440x900 viewport at 2x, dark and light, English, no animations. This folder is its own tiny package and is not part of the pnpm workspace (`pnpm-lock.yaml` is untouched).

```sh
# 1. Start the demo in one terminal (seeds "Demo Studio", serves http://localhost:8788). Use demo:reset for a clean story.
pnpm demo:reset

# 2. Once: install Playwright and its Chromium
cd scripts/screenshots && npm install && npx playwright install chromium

# 3. Capture (from this folder; from the repo root, `pnpm screenshots -- <options>` does the same)
node capture.mjs [--base http://localhost:8788] [--out ../../docs/assets/screenshots] [--only name,name] [--themes dark,light] [--scale 2]
```

Output: `<name>-<theme>.png` for each shot in `docs/assets/screenshots/`, and `manifest.json` (name, title, theme, file, width, height, alt). The README and the website build read the manifest; the website shows its Screenshots section only when the manifest exists. A partial run (`--only`) merges into the existing manifest.

Other options: `--reset` (POST /demo/reset first; never done unless asked), `--hide-demo-banner`, `--headed` (watch it work), `--list` (print shots and routes, no browser), `--help`. `--only` takes full names, numbers or short names: `--only 02,06,aso`.

The script stops at once when `GET /demo/status` does not answer `demo: true`, so it cannot run against a real workspace. It signs in with `/demo/login` (owner). A shot that cannot be taken (a selector does not show) logs a warning with the page URL and the run goes on; the exit code is 1 if any shot failed. Shots are data in the `SHOTS` array of `capture.mjs`: `{ name, title, alt, path(ctx), ready, before?, clip? }`.

Tests (no browser needed): `node --test scripts/screenshots/capture.test.mjs`, also run by `pnpm test:scripts`.

The demo bar ("Demo workspace") stays in the pictures by default; `--hide-demo-banner` hides it through its `data-testid="demo-banner"`.
