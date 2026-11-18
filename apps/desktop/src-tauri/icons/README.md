Icons are generated, not committed by hand. From `apps/desktop` run:

    pnpm tauri icon path/to/app-icon.png

Use a square PNG of at least 1024x1024. This writes every file listed in `tauri.conf.json`.
Until then `tauri dev` and `tauri build` will fail on the missing icons.
