# Desktop localisation

How the desktop shell (`apps/desktop`, Tauri) is translated. The decision is [ADR 0046](adr/0046-desktop-localisation.md); the web app is in
[i18n.md](i18n.md); the translators' guide is [translating.md](translating.md); the terms are in [i18n-glossary.md](i18n-glossary.md).
The Rust has not been compiled yet (ADR 0046): the catalogs are checked, the code is not.

## What is translated

Only what the Rust shell itself shows: the **menu bar** (About, Hide, Quit, Edit, Window, …) and the **start-up error messages**. The web
app inside the window is translated by the web catalogs (the language picker there). The window title and the product name `Kiln` stay as
they are. Notification texts come from the web app.

## The catalogs

`apps/desktop/locales/desktop/<language>.json`: `en.json` is the source, `fr.json`, `es.json`, `de.json` are translations. Same rules as the
web catalogs:

- flat keys, dot-separated camelCase ids (`menu.hideOthers`, `edit.selectAll`), values are text with `{{name}}` placeholders;
- keys sorted, 2-space indent, final newline (`pnpm i18n:fix` style; Weblate writes the same bytes);
- **no plurals**: a message with a count does not exist in the shell yet. If one is ever needed, extend `i18n.rs` first (it does not read
  `_one`/`_other`);
- no HTML, no tags. `{{app}}` is the product name (`Kiln`); `{{message}}` is a technical error text and stays untranslated.

| Prefix                         | What                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `menu.*`                       | Titles of menus and of the application-menu items (`menu.quit`: "Quit {{app}}") |
| `edit.*`, `view.*`, `window.*` | Items of the Edit, View and Window menus                                        |
| `error.*`                      | Start-up errors, printed to stderr                                              |

Translate menus the way the platform's own apps word them (French macOS: "Présentation", German: "Darstellung", Spanish: "Visualización"),
following the glossary. Keep it short: menu titles are one word.

## Which language the shell uses

The operating system's UI language, resolved once at start; the first language in the user's list that has a catalog wins, otherwise English.
`KILN_LANG=fr` forces one (try it: `KILN_LANG=de pnpm --filter @kiln/desktop dev`). It does **not** follow the language chosen inside the web
app (ADR 0046, decision 5). Order: `KILN_LANG`; macOS `defaults read -g AppleLanguages` or Windows UI language; `LANGUAGE`, `LC_ALL`,
`LC_MESSAGES`, `LANG`. A missing or empty string falls back to English, then shows the key.

## Add a string

1. Add the key to `locales/desktop/en.json` (and fr, es, de if you are fluent and keep to the glossary; otherwise leave them out for Weblate).
2. Use it: `i18n::t("menu.example")` or `i18n::t_with("menu.example", &[("app", "Kiln")])`. Keys are literals (a test reads the source).
3. The check below, and `cargo test` (the module tests check JSON validity, that every key used in `main.rs` and `menu.rs`
   is in English, and that placeholders match English).

## Add a language

1. `locales/desktop/<code>.json`, translated.
2. One line in the `CATALOGS` array in `src-tauri/src/i18n.rs` (an `include_str!`).
3. The language in `CFBundleLocalizations` in `src-tauri/Info.plist`.
4. Register it for the web (`availableLocales`, translating.md step 5) and add it to the Weblate language filter.

## Weblate

The existing discovery expression only looks in `apps/web/locales`. For the desktop add **a second Component discovery add-on** on the same
component (it can be installed more than once):

| Field                                                                                     | Value                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Regular expression to match translation files against                                     | `apps/desktop/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json` |
| Customize the component name                                                              | `{{ component\|title }}` (the component is called `Desktop`)           |
| Define the monolingual base filename                                                      | `apps/desktop/locales/{{ component }}/en.json`                         |
| Define the base file for new translations                                                 | `apps/web/locales/empty.json`                                          |
| Language filter                                                                           | `^(en\|fr\|es\|de)$` (as the first one)                                |
| Remove components for inexistent files, Copy translation settings from the main component | on                                                                     |

One expression for both apps is possible: `apps/(?P<app>web|desktop)/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json` with the base
file `apps/{{ app }}/locales/{{ component }}/en.json`, if your Weblate version exposes extra named groups to the templates; two add-ons
need no such feature. Namespace names must stay unique across apps (`desktop` is the only one under `apps/desktop`), because a component is
named after its folder.

## Check

`scripts/i18n.mjs` reads only `apps/web/locales` today. Its functions take a directory, so the desktop catalogs are checked with the same rules
by one more call:

```
node --input-type=module -e "import {checkCatalogs,readCatalogFiles} from './scripts/i18n.mjs'; import {join} from 'node:path'; const r=checkCatalogs(readCatalogFiles(join(process.cwd(),'apps/desktop/locales'))); console.log(r.errors.length? r.errors.join('\n'): 'desktop catalogs ok', JSON.stringify(r.coverage)); process.exit(r.errors.length?1:0)"
```

To have `pnpm i18n:check` (and so `pnpm test`) do it, `runCheck` in `scripts/i18n.mjs` needs one more call (see the report that came with ADR 0046;
the web usage scan must not see the `desktop` namespace, or `--strict` would call its keys unused).
