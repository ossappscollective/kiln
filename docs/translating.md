# Translating Kiln

Kiln is translated on [Weblate](https://weblate.org) (hosted or self-hosted). The translation files are plain JSON in the repository;
Weblate reads and writes them through git. This page is for translators and for the maintainer who sets Weblate up. How the code uses the
files is in [i18n.md](i18n.md); the words to use are in [i18n-glossary.md](i18n-glossary.md).

## For translators

1. Open the Kiln project on Weblate, choose your language, then a component. Each component is one area of the app: `common` (buttons,
   shared words), `shell` (navigation, menus), `auth` (sign-in), `aso`, `release`, … Start with `common` and `shell`: people see them most.
2. A string has a **key** (`shell:nav.allApps` is shown as the string's context) and an English **source**. Translate the whole sentence.
3. Keep what is in curly braces or angle brackets exactly as it is:
   - `{{name}}`, `{{count}}`: values the app puts in. You may move them to where your language needs them.
   - `<link>…</link>`, `<strong>…</strong>`, `<code>…</code>`: a link or emphasis. Translate the words between the tags, keep the tags, do not add others.
4. **Plurals.** A string with a number appears once for each form your language needs ("one", "other", and for French and Spanish "many").
   Write a complete sentence in each. In French, "one" is also used for 0 ("0 avis"). If a form has no number in English ("One item"), you may
   write it without the placeholder; otherwise keep `{{count}}`.
5. Use the terms of the glossary ([i18n-glossary.md](i18n-glossary.md)). Product and store names (Kiln, TestFlight, App Store Connect, Google
   Play, RevenueCat, EAS, MCP, API, SKU) stay in English.
6. Register: French uses "vous"; German uses "Sie"; Spanish prefers the infinitive for buttons ("Guardar") and a neutral Latin-American
   "tú" imperative only where a sentence must address the reader.
7. Keep punctuation inside the string, including a colon or a question mark. In French put a non-breaking space before `:`, `?`, `!`, `;`
   and use `’` for the apostrophe.
8. Not sure about a string? Add a comment in Weblate; do not guess a placeholder. The app falls back to English for anything you leave empty.
9. **Preview**: the pseudo-locale and a language switch show the result in a running app. Run Kiln (`pnpm dev`) and open the app with
   `?lang=fr` (or `de`, `es`) at the end of the address, or change the language in the account menu. Strings you have not translated yet show
   in English. With `?lang=pseudo` every string is wrapped in `[ ]` with accents, so anything still in plain ASCII is hard-coded in the code:
   report it as an issue.

Every file is checked before it is merged: placeholders and tags must match the English, no HTML, only valid plural forms. Weblate shows
a failed check as a warning on the string; fix it there.

## For maintainers: set up Weblate

The layout is fixed so Weblate can find every file by itself:

```
apps/web/locales/<namespace>/<language>.json        e.g. apps/web/locales/shell/fr.json
apps/web/locales/<namespace>/en.json                the source (monolingual base) of that namespace
apps/web/locales/empty.json                         {}  the template for a new language
apps/server/locales/<namespace>/<language>.json     e.g. apps/server/locales/email/fr.json (emails the server sends)
apps/desktop/locales/<namespace>/<language>.json    e.g. apps/desktop/locales/desktop/fr.json (menus, see i18n-desktop.md)
```

The web app's sentences for server errors are in `apps/web/locales/errors` (a normal web component, `Errors`); see
[i18n-server.md](i18n-server.md).

### 1. The project

Create a Weblate project "Kiln" with the repository URL, the branch (`main`), and **Push branch** `weblate` (translators' commits go to a
branch and a pull request; do not push to `main`). Component settings below apply to all components made by the discovery add-on.

### 2. The first component and component discovery

Create one component by hand to carry the settings, then let the **Component discovery** add-on create one component per namespace. Name the
first component `common` and give it:

| Setting                        | Value                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File format                    | **i18next JSON file v4** (the "JSON file" family; do not choose the plain "JSON file" or "go-i18n" formats)                                            |
| File mask                      | `apps/web/locales/common/*.json`                                                                                                                       |
| Monolingual base language file | `apps/web/locales/common/en.json`                                                                                                                      |
| Template for new translations  | `apps/web/locales/empty.json` (an empty `{}`: a new language starts with nothing translated, so untranslated text is never mistaken for a translation) |
| Source language                | English (`en`)                                                                                                                                         |
| Language code style            | **BCP style** (hyphen: `pt-BR`; `fr`, `es`, `de` are the same in any style)                                                                            |
| Push on commit, Merge style    | rebase (keeps history linear)                                                                                                                          |

Then **Add-ons, Component discovery** on that component:

| Field                                                 | Value                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Regular expression to match translation files against | `apps/web/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json`      |
| Customize the component name                          | `{{ component\|title }}`                                                |
| Define the monolingual base filename                  | `apps/web/locales/{{ component }}/en.json`                              |
| Define the base file for new translations             | `apps/web/locales/empty.json`                                           |
| Language filter                                       | `^(en\|fr\|es\|de)$` (add a language here when you register it, step 4) |
| Remove components for inexistent files                | on                                                                      |
| Copy translation settings from the main component     | on (so every discovered component gets the same format and add-ons)     |

The server and the desktop have their own catalogs with the same format and rules. Add **one Component discovery add-on per app** on the
same component (the add-on can be installed several times), with the same values as above and only these fields changed:

| App     | Regular expression                                                     | Monolingual base filename                      |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| server  | `apps/server/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json`  | `apps/server/locales/{{ component }}/en.json`  |
| desktop | `apps/desktop/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json` | `apps/desktop/locales/{{ component }}/en.json` |

One expression for the three apps is also possible, `apps/(?P<app>[^/]*)/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json` with
the base file `apps/{{ app }}/locales/{{ component }}/en.json`, if your Weblate version exposes extra named groups to the templates.
Namespace names must stay unique across the three apps (a component is named after its folder): `email` is the server's, `desktop` the
desktop's, the web uses the rest. `pnpm i18n:check` checks all three folders.

The regex is the one place that knows the layout: it matches `apps/web/locales/shell/fr.json` as component `shell`, language `fr`.
`apps/web/locales/empty.json` has no namespace folder, so the expression never matches it; `en.json` matches as the source-language file of its
component (English is the base, not something to translate).

### 3. Add-ons that keep the files tidy

Add these to the component (they are copied to discovered components):

- **Customize JSON output**: _Sort JSON keys_ on, _JSON indentation_ `2`. Weblate then writes keys sorted with two spaces, which is the layout
  `pnpm i18n:check` requires, so a Weblate commit does not change formatting. (Add-on names are those of Weblate 5; check the add-on list
  of your version.) If a Weblate commit ever fails the "not formatted" check, run `pnpm i18n:fix` on the branch.
- **Cleanup translation files**: removes strings that no longer exist in the English file.
- **Remove blank strings**: keeps untranslated strings out of the files (the app treats an empty value as untranslated either way).
- **Squash Git commits** (per language): one commit per language per push, so the history is readable. Optional: **Stale suggestion removal**.
- Suggestions: enable "Enable suggestions" and "Suggestion voting" if you want review before text is accepted; accept suggestions only from
  reviewers for languages with an owner.

### 4. Commit messages

Keep Weblate's default message (`Translated using Weblate (French)` with the percentage) and set:

- _Commit message when translating_: `i18n(<language>): translated using Weblate ({{ language_name }})`
- _Commit message when adding translation_: `i18n(<language>): added translation using Weblate ({{ language_name }})`
- _Commit message when deleting translation_: `i18n: removed {{ language_name }} translation`
- _Committer name_ `Weblate`; do not add the `Co-Authored-By` trailers that agents use: Weblate credits translators itself.

### 5. Add a language

1. Add it to `availableLocales` in `apps/web/src/lib/i18n/locales.ts` (`{ code: 'it', name: 'Italiano', dir: 'ltr', htmlLang: 'it' }`; the name
   is the language written in itself). Its plural forms are taken from `Intl.PluralRules`, nothing else to declare.
2. Add the language to the discovery **Language filter**, then in Weblate use _Start new translation_ in each component (or let the
   add-on _Add missing languages_ do it). Each new file starts as a copy of `empty.json`.
3. Translate. `common` and `shell` first.
4. Run `pnpm i18n:check`: it reports the percentage translated per language and fails if a file is malformed. A language at 0 percent is fine to
   merge (it falls back to English); consider hiding it from the picker until `common` and `shell` are done.

### 6. What is validated, and where

`pnpm i18n:check` (also run by `pnpm test` and CI) checks every file: valid JSON, sorted and indented as above, no key English lacks, the
same `{{placeholders}}` and `<tags>`, plural suffixes valid for the language, no HTML, and that every key the code uses exists in English.
Missing translations are reported with a percentage and never fail the build.

## Status

Weblate itself has **not** been connected to this repository by the author of this page; the regular expression, the add-on names and the
settings are written from Weblate's documentation. Verify the first sync (the discovered component names, a round trip that leaves the JSON
files byte-identical, a plural string of a French translation) and correct this page where the real thing differs.
