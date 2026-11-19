Icons are generated from one square PNG. From `apps/desktop` run:

    pnpm tauri icon path/to/app-icon.png

Use a square PNG of at least 1024x1024. This writes every file listed in `tauri.conf.json`.
Until then `tauri dev` and `tauri build` will fail on the missing icons.

The files here are a generated placeholder (a blue square with an arrow, from `source-1024.png`).
Replace them with real artwork by running the command above on your own 1024x1024 PNG.
