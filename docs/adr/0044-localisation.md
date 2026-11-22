# ADR 0044: Localisation with JSON catalogs, our own runtime and Weblate

Status: foundation built (runtime, formatting, tooling, pilot screens, docs). Weblate has not been connected; the other screens, the server
messages and the desktop menus are still English. How it works: [docs/i18n.md](../i18n.md); for translators: [docs/translating.md](../translating.md).

## Context

The owner wants the whole product translatable, first into French, Spanish and German, by volunteers through Weblate, with English as the
source. About 314 Svelte components and 150 lib modules hold hard-coded English (the scan counts roughly 4,200 strings in templates and 2,700
sentence-like literals in lib modules), and many are built from fragments (`${n} ${n === 1 ? 'app' : 'apps'}`). The web app has no runtime
dependencies and a strict CSP (`default-src 'self'`); that is a feature and stays. Conversion will be done by several agents in parallel, so
the layout must keep their files disjoint and the conventions must be checkable.

## Decision

1. **Catalogs are JSON in the i18next v4 layout, one file per namespace per language**: `apps/web/locales/<namespace>/<language>.json`.
   Keys are flat, dot-structured semantic ids; values are English text with `{{name}}` placeholders; plurals are `_one`/`_other` (plus
   `_zero`, `_two`, `_few`, `_many` where CLDR has them). Files are written sorted, 2-space indented, with a final newline. English is the
   source; the other files are Weblate's.
2. **Weblate finds the files by component discovery** with `apps/web/locales/(?P<component>[^/]*)/(?P<language>[^/.]*)\.json`, so a new
   namespace needs no Weblate work and a namespace is one component. A new language starts from an empty file.
3. **Our own runtime of about 300 lines, no dependency.** `t('ns:key', params)`, `<T>` for rich text, `Intl.PluralRules` for plurals,
   fallback to English then to the key. It is plain TypeScript (testable with `node --test`); a small `.svelte.ts` wrapper holds the active
   language in a `$state` so templates update. We did not adopt i18next or Paraglide: the file format is the compatible part, the engine
   would add a dependency, a build step or a bundle cost for little we use. The format keeps that door open.
4. **English is bundled; other languages are lazy chunks loaded before the app mounts**, so there is no flash of keys and `t()` stays
   synchronous (no loading states in every component). A slow fetch (over 4 seconds) mounts in English and switches later.
5. **Formatting is `Intl`, through one module** (`lib/i18n/format.ts`): numbers, percent, money (major units and minor-unit strings, no
   float arithmetic on the latter), dates, relative time, lists, sizes, durations, display names. The tag follows the app language and
   takes the region of the browser's matching language. No locale argument is left in call sites.
6. **No HTML in messages.** Rich text is `<link>text</link>`-style tags from a closed list (`link`, `link2`, `link3`, `strong`, `em`,
   `code`), parsed into parts and drawn by a Svelte component with snippets. No `{@html}`; a parameter cannot add a tag.
7. **The language is a per-browser choice** (`localStorage` `kiln.locale`), then the browser's languages, then English; `?lang=` previews a
   language without saving it; a pseudo-locale (accents, brackets, about 30 percent longer) finds hard-coded text and clipped layouts.
   Moving it to a user profile later is possible and not needed now.
8. **Conventions are enforced by tooling**: `scripts/i18n.mjs` (`pnpm i18n:check`, `i18n:fix`, `i18n:scan`) run by the web tests. It checks
   file layout, orphans, placeholders, tags and plural suffixes per language, and that every literal key in the source exists. Missing
   translations are reported, never failures. Keys must be literals (`k('ns:key')` in typed maps), so the check can see them.

## Consequences

- Translators work in Weblate on text that has context (key, namespace, glossary) and cannot break code: placeholders and tags are checked.
- Agents can convert disjoint areas in parallel: one namespace each, no shared catalog to conflict on, and a test that fails on a bad key.
- Code that built text from fragments must be rewritten as whole messages with plurals. That is the real cost of the work, not the plumbing.
- Lib modules that call `t()` need the English catalogs in tests: `pnpm test` preloads them (`--import ./src/lib/i18n/test-setup.ts`); running
  a single test file without that flag returns keys.
- A module-level constant cannot hold translated text; it holds keys (`labelKey: k('…')`) and the view translates. This is the rule people
  will trip on most.
- The first paint waits for one extra small request when the language is not English; the English catalogs are in the main bundle
  (size grows with the app; if it becomes a problem, make English lazy per namespace and accept `await` at route boundaries).
- Each language needs its plural forms: Weblate and `Intl` agree on CLDR; a language `Intl` does not know falls back to `other` only.

## Not decided / not built

- Server messages shown to people: decided in [ADR 0045](0045-server-message-localisation.md). Originally: the server will define an `errors` namespace keyed by error
  code and a language for outgoing mail. The web maps `code` to `errors:<code>` and falls back to the server's English message.
- Desktop (Tauri) menus and window titles.
- A user-profile language field and an "Automatic" picker entry.
- Right-to-left languages (`dir` is set; the CSS still has physical left/right in places).
- Weblate has not been connected; see the status section of docs/translating.md.
