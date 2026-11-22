# ADR 0046: Localisation of the desktop shell

Status: written, **not compiled**: the Rust (`apps/desktop/src-tauri/src/i18n.rs`, `menu.rs`) was written without a Rust toolchain, like the rest
of the shell. The catalogs are checked by `scripts/i18n.mjs`'s own rules. How to maintain them: [docs/i18n-desktop.md](../i18n-desktop.md); the
web side: [ADR 0044](0044-localisation.md).

## Context

The web UI loads in the Tauri window from the sidecar server and is translated by ADR 0044. The Rust shell around it has little text of its
own. The inventory of `apps/desktop` (Rust, `tauri.conf.json`, capabilities, sidecar launcher) found:

| Where                             | Text                                                                                                         | Person-facing?                            | Decision                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Window title (`main.rs`)          | `Kiln`                                                                                                       | yes                                       | Product name: never translated (glossary). Stays a literal.                       |
| Menu bar                          | none set; Tauri's default menu has **English** labels whatever the system language is                        | yes                                       | New `menu.rs`: the same predefined items with catalog labels.                     |
| Start-up errors (`main.rs`)       | "The server did not become ready in time.", "Cannot open the window: …"                                      | on stderr only (the app exits; no dialog) | In the catalog (`error.*`).                                                       |
| Developer diagnostics (`main.rs`) | "cannot read OS randomness", "the packaged server is missing; run prepare-sidecar", "server entry not found" | no: they tell a developer what to run     | Left in English on purpose; translated logs would be harder to search and report. |
| Tray, dialogs, updater            | none exist                                                                                                   |                                           | Nothing to convert. When one is added it uses `i18n::t`.                          |
| Notifications                     | text is built by the web app (`lib/alerts/notify.ts`, namespace `workspace`) and handed to the plugin        | yes                                       | Web catalogs, not this one.                                                       |
| `tauri.conf.json`                 | `productName` `Kiln`, no window titles (`windows` is empty)                                                  |                                           | Not translated.                                                                   |
| Installer metadata                | none translatable today                                                                                      |                                           | Skipped (see below).                                                              |

The assumption that Tauri's predefined menu items "follow the OS language" does not hold: muda (Tauri's menu layer) gives them English labels
unless a label is passed. So the shell builds the menu itself and passes translated labels to the predefined items, which keeps their native
behaviour (Undo, Copy, Hide, Quit, full screen) and shortcuts.

## Decision

1. **Catalogs** live in `apps/desktop/locales/desktop/<language>.json`: one namespace, `desktop`, in the same flat i18next-v4 layout as the
   web (sorted keys, 2 spaces, final newline, `{{param}}` placeholders, no plurals: the shell has no counted messages). English is the
   source; French, Spanish and German are translated by hand following the glossary (system-menu wording follows each platform's own, for
   example "Présentation", "Visualización", "Darstellung"). Weblate finds them by component discovery like the web catalogs
   (docs/i18n-desktop.md).
2. **Embedded at compile time** with `include_str!`, parsed with `serde_json` into a `HashMap<String, String>`. A malformed catalog gives an
   empty map (lookups fall back), never a panic at start-up; a unit test keeps them valid.
3. **Lookup**: language, then English, then the key itself; an empty value counts as untranslated (what Weblate leaves). `{{name}}` is replaced
   in one pass from `&[(&str, &str)]`; an unknown placeholder stays as written; a value is never re-scanned.
4. **Language** is the operating system's UI language, resolved once at start (`i18n::init()`), first matching language wins, else English:
   - `KILN_LANG` (testing and override: `KILN_LANG=fr`), then
   - macOS: `defaults read -g AppleLanguages` (an app started from Finder has no `LANG`), Windows: `GetUserDefaultUILanguage` and
     `LCIDToLocaleName` from kernel32 (declared by hand, no crate), then
   - `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG` (Linux, and a terminal launch anywhere); `C` and `POSIX` are ignored.

   Tauri 2 (2.12 in Cargo.lock) has no locale API in core, and `sys-locale` is not in Cargo.lock, so none is used.
5. **The web app's saved language does not drive the shell.** It lives in the webview's `localStorage`, which Rust cannot read at start, and
   the menu is built before the page loads. Consequence, accepted: someone whose system is English but who picked French in the web app has
   a French page inside an English menu bar, and the other way round. A later step could let the page tell the shell (a Tauri command
   behind a capability for the local origin) and rebuild the menu; it is not worth a new IPC surface now.
6. **Dependencies**: one direct dependency added, `serde_json = "1"`. It is **already in `Cargo.lock`** (1.0.154, through tauri), so no new
   crate is downloaded; `Cargo.toml` and the `kiln-desktop` entry of `Cargo.lock` name it. No locale crate.
7. **Menu** (`menu.rs`): macOS application menu (About, Services, Hide, Hide Others, Quit), File, Edit, View (full screen, macOS), Window;
   on Windows and Linux File also holds Quit (Exit on Windows) and a Help menu holds About. Labels come from the catalog; there are no custom
   items, so no event handling. Items Tauri's default adds that this one does not: the macOS Window menu's list of open windows (needs the
   `WINDOW_SUBMENU_ID` id; add it when the shell is first compiled and the constant can be checked).
8. **macOS bundle languages**: `src-tauri/Info.plist` (merged by Tauri into the bundle's) declares `CFBundleLocalizations` en, fr, es, de, so
   AppKit and the web view localise what the OS owns (the web view's right-click menu, Dictation and Emoji in Edit, standard dialogs).
   Without it macOS treats the app as English-only. Verify on the first macOS build.
9. **Installer metadata is skipped.** The DMG has none; the Windows installers (NSIS `languages`, WiX `language`) are build settings that
   cannot be verified without a Windows build, and a wrong value breaks the release build. Add them with the first Windows release.

## Consequences

- A new language is: a file `locales/desktop/<code>.json`, one line in `CATALOGS` in `i18n.rs`, the language in the Weblate language filter and
  in `Info.plist`. Missing strings fall back to English.
- Because the catalogs are not in `apps/web/locales`, `scripts/i18n.mjs` and the Weblate discovery regex must be told about them
  (docs/i18n-desktop.md has the exact change). Until then CI does not see them; `cargo test` does check them (valid JSON, every key in
  English, same placeholders, every key used in `main.rs` and `menu.rs` exists).
- Everything in this ADR is uncompiled and untested on a machine: expect small fixes on the first `cargo check`, and check the menus once
  in each language (`KILN_LANG=fr pnpm --filter @kiln/desktop dev`).

## Not decided / not built

- A shell-side language setting, and syncing with the web app's choice (decision 5).
- Error dialogs: start-up failures still only print to stderr and exit. When they get a dialog, the strings are `error.*` already.
- Windows and Linux menu text follows the platform's habits only loosely (one wording per language).
