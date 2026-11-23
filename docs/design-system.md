# Design system

A dark-first, indigo-and-violet system for the web UI (`apps/web`): deep indigo surfaces, one brand gradient
(blue to violet to ember, the colors of the Kiln mark) used sparingly, Space Grotesk for headings and figures, Inter
for text, rounded cards and controls, a strict 4px grid. The whole look is a set of CSS custom properties in one
file, so it can be changed in one place. Nothing here has been checked on rendered pages yet; look at the screens by
eye when you first run `pnpm --filter @kiln/web dev`, in both themes.

## Principles

- Content first. Borders and spacing carry the structure; glows and the gradient are accents, never the layout.
- One accent. Color means something: blue for action and selection, green, amber, red and cyan tints for status.
  Never use color alone; the text or an icon must say the same thing.
- Sentence case, plain words, no exclamation marks, no emoji.
- Keyboard first. Every control has a visible focus ring (a 2px violet ring and a soft halo), a real element and an
  accessible name.
- Decorative effects (glows, the ambient light, the gradient bar) live in backgrounds and pseudo-elements, so a
  screen reader never meets them, and animation stops under `prefers-reduced-motion`.

## Where things live

| What                                                                                                      | File                               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Every token**: colors (light and dark), borders, shadows, glows, gradients, fonts, radii, space, motion | `apps/web/src/styles/theme.css`    |
| Solid colors as TypeScript, for the contrast test (mirrors `theme.css`)                                   | `apps/web/src/lib/tokens.ts`       |
| The brand-gradient accents: primary button, page title and header glow, `.accent-edge`                    | `apps/web/src/styles/accents.css`  |
| Reset, type, forms, buttons, cards, tables, badges, alerts, sidebar navigation (global classes)           | `apps/web/src/app.css`             |
| Theme choice (Auto, Light, Dark), remembered in `localStorage`                                            | `apps/web/src/lib/theme.ts`        |
| Components                                                                                                | `apps/web/src/components/ui/`      |
| Toast store                                                                                               | `apps/web/src/lib/toast.svelte.ts` |

`app.css` imports `theme.css`; `main.ts` loads `app.css` and then `accents.css`. `lib/contrast.test.ts` fails if the
solid hex values of `theme.css` and `tokens.ts` differ, if the two dark blocks differ, if a text or graphic pair
listed in `tokens.ts` falls below WCAG AA in either theme, or if a component or stylesheet hard-codes a color.

## How to retheme

Edit `apps/web/src/styles/theme.css`, and for a solid color the same line in `apps/web/src/lib/tokens.ts`, then run
`pnpm --filter @kiln/web test`.

| To change                               | Edit                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The brand gradient (logo, bars, glows)  | `--brand-blue`, `--brand-violet`, `--brand-ember` (shared block); the primary button uses `--primary-from/-to`      |
| The primary button                      | `--primary-from`, `--primary-to` (themed, keep `--accent-ink` readable on both), `--btn-glow`                       |
| Surfaces, text, accent, status colors   | The themed blocks: light (`:root`), dark (`:root[data-theme="dark"]`, repeated in the `prefers-color-scheme` block) |
| Corner radii                            | `--radius-sm` (small parts), `-md` (controls), `-lg` (cards), `-xl` (dialogs), `-full` (chips)                      |
| Fonts                                   | `--font-sans`, `--font-display`, `--font-mono`; weights `--weight-*`                                                |
| Shadows and glows                       | `--shadow-xs` to `-lg`, `--shadow-card`, `--btn-glow`, `--nav-bar-glow`, `--seg-selected-ring`, `--dot-glow-blur`   |
| The ambient light behind page titles    | `--ambient` (three radial gradients)                                                                                |
| Focus ring                              | `--ring`, `--halo`, `--focus`, `--focus-soft`                                                                       |
| Chart colors, line width, glow and area | `--viz-1`, `--viz-2`, `--viz-mid`, `--viz-end`, `--viz-line-width`, `--viz-glow-blur`, `--viz-area-opacity`         |

The dark colors are written twice, once for `data-theme="dark"` and once for the system setting; keep the two blocks
identical (a test checks it). The fonts are not downloaded: the server sends `default-src 'self'`, and Kiln avoids
third-party requests. Space Grotesk and Inter are used when they are installed; otherwise the system UI font takes
over. To ship them, put the `woff2` files in `apps/web/public/fonts/`, add `@font-face` rules at the top of
`theme.css` (a same-origin `url()` is allowed by the CSP), and add the OFL licenses to `THIRD_PARTY_NOTICES.md`.

## Where the gradient is used

Only on these accents (decorative or redundant with text or an icon):

1. the logo (`Logo.svelte`) and nothing else that is a "brand" mark;
2. the primary button (`--primary-gradient`, with `--btn-glow`);
3. the current item in the sidebar: a soft wash (`--nav-active-bg`) and a 4px bar (`--brand-gradient-vertical`, `--nav-bar-glow`);
4. the 1px gradient border of summary cards (`.accent-edge`: chart cards, the figures above them);
5. the line of a single-series chart (with a blurred glow copy and a fading area);
6. the selected segment of a segmented control (violet ring and glow, `--seg-selected-ring`);
7. the focus ring and halo;
8. the ambient light behind a page title (`--ambient`) and the title text (`--title-gradient`, ink fading into violet).

Do not add it to body text, table rows, badges, borders or backgrounds of content.

## Surfaces, tables and glows: rules that avoid "a box in a box"

- **Tables are flush inside cards and sections.** A `.table-wrap`, or a `.card` that holds only a table, inside a `.card` or a
  Section has no border, radius, shadow or fill of its own (one rule in `app.css`); it is the table, with a top hairline where the
  card above draws none, and it scrolls sideways instead of squashing. Only a table that stands alone on the page keeps its own
  bordered, rounded wrapper. Never put a second rounded border directly under a section header.
- **Row actions** are `td.actions`: a real table cell (never `display: flex` on the `td`), one line (`nowrap`), centered on the
  row. Cells are vertically centered, so a chip, a date and an action stay on one line.
- **The ambient glow is a fading page layer, not a box.** It is painted once, behind the top bar and the page title (Shell
  `.column::before`, and the login page), from pixel-sized ellipses anchored to the top right that reach transparent well inside the
  layer (`--ambient`). Do not paint it on a header or card element: an element's edge would clip it into a visible rectangle.
- **The current navigation item is one shape:** square on the left, where the 4px gradient bar sits flush and full height, with a
  wash that fades to nothing to the right.
- **Segmented controls** (`SegmentTabs`, the theme toggle, List | Board, scope and range controls) use a borderless `--seg-track`
  and a raised `--seg-selected` pill with `--seg-selected-ring` (a soft shadow and a faint violet ring); no dark outline.

## Themes

Dark is the look of the product. `data-theme="light|dark"` on `<html>` (the Theme setting in the account menu) wins;
with the setting on Auto the system decides (`prefers-color-scheme`), and light is used when the system has no
preference. Light keeps the same structure with softer tints, a white sidebar and card, and deeper gradient ends so
text and marks stay readable. The choice is saved under the theme key in `localStorage` (a failure to save is
ignored). Write components against the variables below and they work in both. Never hard-code a color.

## Color tokens

| Group        | Variables                                                                                  | Use                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Surfaces     | `--ground` `--sidebar` `--surface` `--surface-sunken` `--surface-hover` `--surface-active` | Page, sidebar, cards, track and code, raised or hovered, pressed or selected            |
| Roles        | `--chip-bg` `--track` `--raised` `--field-bg` `--seg-selected`                             | Names for a role: chip fill, segmented track, raised card, input fill, selected segment |
| Text         | `--ink` `--muted` `--faint`                                                                | Body, secondary text and labels, placeholders and table headers                         |
| Borders      | `--line` `--line-strong` `--line-hover`                                                    | Hairlines and cards, control borders, hovered control borders (translucent)             |
| Accent       | `--accent` `--accent-hover` `--accent-ink` `--accent-bg` `--chip-ink` `--focus`            | Links and selection; text on a solid accent; chip fill and its text; focus ring         |
| Primary      | `--primary-from` `--primary-to` `--title-end`                                              | Ends of the primary button gradient; end of the page-title gradient                     |
| Success      | `--ok-bg` `--ok-ink` `--ok` `--ok-line`                                                    | Tint, text on tint, dot or icon, border                                                 |
| Danger       | `--bad-bg` `--bad-ink` `--bad` `--bad-line`                                                | Same, for errors and destructive actions                                                |
| Warning      | `--warn-bg` `--warn-ink` `--warn` `--warn-line`                                            | Same                                                                                    |
| Info         | `--info-bg` `--info-ink` `--info` `--info-line`                                            | Same                                                                                    |
| Solid danger | `--danger-solid` `--danger-solid-hover` `--danger-solid-ink`                               | The destructive confirm button                                                          |
| Charts       | `--viz-1` `--viz-2` `--viz-mid` `--viz-end` `--viz-grid` `--viz-axis`                      | Chart marks, grid and axis                                                              |
| Misc         | `--scrim` `--focus-soft` `--skeleton-from` `--skeleton-to`                                 | Modal backdrop, focus halo, loading shimmer                                             |

Text on a tint uses the matching `-ink` variable. The solid (`--ok`, `--bad`, `--warn`, `--info`) is for dots, icons
and borders only, never for body text. Every text pair is at least 4.5:1 (ink on surfaces 7:1) in both themes.

## Type, space, shape, motion, layers

- Fonts: `--font-sans` (Inter, then the system UI stack), `--font-display` (Space Grotesk, then `--font-sans`; used
  by `h1`-`h3`, `.stat-value`, `.display`, the wordmark and stat figures) and `--font-mono` (secrets, ids, code).
  Numbers in tables and times use tabular figures automatically (`td`, `time`, `.num`).
- Sizes: `--text-xs` 12, `--text-sm` 13, `--text-base` 14 (body), `--text-md` 16, `--text-lg` 18,
  `--text-xl` 20, `--text-2xl` 24 (page title), `--text-3xl` 30. Weights: 400, 500, 600 (`--weight-display` for headings).
- Space, on a 4px grid: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32, `-10` 40,
  `-12` 48, `-16` 64. Use only these.
- Radii: `--radius-sm` 6 (small parts), `-md` 12 (buttons, inputs, segments), `-lg` 18 (cards, panels), `-xl` 20
  (dialogs), `-full` (chips and pills).
- Control heights: `--control-sm` 28, `--control-md` 36, `--control-lg` 40.
- Shadows: `--shadow-xs` (controls), `-sm`, `-md` (menus), `-lg` (dialogs, toasts), `--shadow-card` (cards).
- Motion: `--duration-fast` 100ms, `-base` 160ms, `-slow` 240ms, `--ease`. Under
  `prefers-reduced-motion` all animation and transition is cut to nothing.
- Layers: `--z-sticky` 10, `-sidebar` 20, `-dropdown` 30, `-overlay` 40, `-modal` 50, `-toast` 60,
  `-tooltip` 70.
- Layout: `--sidebar-width` 248px, `--sidebar-rail-width` 64px (the folded left panel), `--topbar-height` 56px, `--content-width` 1120px.

## Global classes (plain markup)

These work without any component. The first group is relied on by existing screens, so do not
rename them.

| Class                                                                                   | Notes                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button`, `.btn`                                                                        | Secondary by default. Modifiers: `.primary`, `.danger`, `.primary.danger` (solid), `.ghost`, `.link`, `.bare` (strip the look for custom controls), `.sm`, `.lg`, `.icon` (square), `.block`, `.loading` (spinner, blocks clicks) |
| `input`, `select`, `textarea`                                                           | Hover, focus and disabled states. `aria-invalid="true"` shows the error border                                                                                                                                                    |
| `.field`, `.hint`, `.field-error`, `.required`, `.check`, `.input-group`                | Form layout. `.hint` is helper text, `.field-error` an inline message                                                                                                                                                             |
| `.card`                                                                                 | Modifiers `.flush` (no padding) and `.raised`. Parts: `.card-header`                                                                                                                                                              |
| `.badge`                                                                                | Modifiers `.ok` `.bad` `.warn` `.info` `.accent` and `.dot`                                                                                                                                                                       |
| `.alert`                                                                                | Modifiers `.error` `.info` `.warn` `.ok`. The icon comes from CSS. Use `role="alert"` for errors, `role="status"` otherwise                                                                                                       |
| `table`, `th`, `td`                                                                     | Row hover. Add `.sticky` to the table inside a `.table-wrap` (scrolling container) for a sticky header, `.compact` for tight rows, `.num` on a cell to right-align numbers, `td.actions` for row buttons                          |
| `.row`, `.stack`, `.spacer`                                                             | Flex row, vertical rhythm (`.stack.tight`, `.stack.loose`), flexible gap                                                                                                                                                          |
| `.page-header`, `.page-title`, `.page-desc`, `.page-actions`                            | The top of a screen                                                                                                                                                                                                               |
| `.empty-state`                                                                          | Centered empty message                                                                                                                                                                                                            |
| `.skeleton`, `.spinner`                                                                 | Loading placeholders                                                                                                                                                                                                              |
| `.muted`, `.mono`, `.tabular`, `.eyebrow`, `.truncate`, `.visually-hidden`, `.no-print` | Utilities                                                                                                                                                                                                                         |

## Components (`components/ui/`)

Each file starts with a comment that lists its props.

| Component                          | Use it for                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                           | Any button or button-styled link. `variant`, `size`, `icon`, `iconOnly` + `label`, `loading`, `block`, `href`                                                                                                                                                                     |
| `TextField`                        | A labelled input with hint, inline error and a password reveal toggle                                                                                                                                                                                                             |
| `Badge`, `Alert`                   | Status labels and inline messages                                                                                                                                                                                                                                                 |
| `Card`, `PageHeader`, `EmptyState` | Page structure                                                                                                                                                                                                                                                                    |
| `Spinner`, `Skeleton`              | Loading. Prefer a skeleton of the real layout for lists and tables                                                                                                                                                                                                                |
| `Modal`                            | Confirmations and short forms. Native `<dialog>`: focus trap, Escape, focus returns to the opener                                                                                                                                                                                 |
| `ToastHost` + `toast`              | Brief confirmation after an action. Mount `ToastHost` once (done in `App.svelte`) and call `toast.success('Saved')`                                                                                                                                                               |
| `Tooltip`                          | A hint for an icon-only control. CSS only, keyboard accessible, Escape hides it                                                                                                                                                                                                   |
| `CopyButton`                       | Copy a value with feedback and a fallback for plain http                                                                                                                                                                                                                          |
| `Tabs`                             | Views of one object. Arrow keys move between tabs                                                                                                                                                                                                                                 |
| `ThemeToggle`, `Logo`              | Theme choice and the product mark                                                                                                                                                                                                                                                 |
| `LanguageSelect`                   | The language choice (a labelled select, options in their own language with `lang`). `layout` inline or stacked, `block`. Saved in this browser; see `docs/i18n.md`                                                                                                                |
| `T`                                | A translated message that has a link or emphasis inside (`<link>…</link>` tags, snippets per tag). Never `{@html}`; see `docs/i18n.md`                                                                                                                                            |
| `Icon`                             | One of the registered inline SVG icons (`lib/icons.ts`), see Icons below                                                                                                                                                                                                          |
| `StoreBadge`, `PlatformBadge`      | A store, tool or platform as a generic glyph plus its name                                                                                                                                                                                                                        |
| `AppIcon`                          | The icon of an app in a square of a fixed size. Loads `iconUrl` of the app JSON (same origin only), falls back to the initials of the app and the platform glyph, never a broken image. Decorative beside the app's name (`labelled`), named when alone. See `docs/api/assets.md` |
| `Disclosure`                       | A summary line that expands in place. Use it for anything that is not the main task of the screen (notes, warnings with detail, history). Open state is kept in memory per screen (`lib/disclosure-state.ts`)                                                                     |
| `InfoTip`                          | A small popover for explanations, legends and read times, so they do not take room on the page. Flips at the window edge                                                                                                                                                          |
| `StatusPill`                       | One line that expands to details; the quiet form of a warning or a disabled feature                                                                                                                                                                                               |
| `StatChip`                         | A compact counter; zero values are dimmed                                                                                                                                                                                                                                         |
| `SegmentTabs`                      | iOS and Android (or other) tabs inside a page, instead of stacked copies                                                                                                                                                                                                          |
| `IconGallery`                      | Dev only: every icon, store badge and status icon on one page. Not routed                                                                                                                                                                                                         |

To show an icon in the navigation, set `icon` on the view in `lib/views.ts`. Its name is `labelKey` (a message key, translated where it is drawn).

## Icons

All icons are inline SVG from one typed module, `apps/web/src/lib/icons.ts`: no font, no sprite, no
CDN, no package, no inline style, so the CSP needs nothing new. It is one module of data (about
14 KB of path strings) and `Icon.svelte` picks one entry. About 100 icons: UI glyphs (status, actions, arrows,
people and access, time, source control, files, layout, devices) and the generic store, platform and
tool marks below.

```svelte
<Icon name="check-circle" />                       <!-- decorative: aria-hidden, put text beside it -->
<Icon name="alert-triangle" size="lg" />           <!-- sm 14, md 16 (default), lg 20, xl 24, or a number -->
<Icon name="external-link" title="Opens in a new tab" />   <!-- role="img" with an accessible name -->
```

| Rule                                                                                                                                                                                           | Why                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Colour is `currentColor`; never set a fill or stroke on the icon, set `color` on the parent. Use the tokens (`--ok`, `--bad`, `--warn`, `--info`, `--muted`) and the matching `-ink` for text. | Both themes work, and contrast is already tested for the token pairs  |
| An icon never carries meaning alone. Give it visible text, or give the control an `aria-label`, or pass `title`.                                                                               | Colour and glyph are not signals for everyone                         |
| Status chips are icon plus text: `Badge` has an `icon` prop; `lib/status-icons.ts` maps a release status, a tone and a role to an icon.                                                        | One consistent look for live, in review, rejected, draft and the rest |
| The size is set by `width` and `height`, so an icon never shifts the layout. Use `sm` inside badges (`Badge` uses 12) and `md` next to body text.                                              | No layout shift                                                       |
| `Button` takes `icon`, `EmptyState` takes `icon`, `Alert` and the toasts already draw an icon for their tone. Do not add a second one.                                                         | Avoid doubled icons                                                   |
| An unknown name draws the neutral `help` glyph instead of nothing. TypeScript flags it first.                                                                                                  | Never an invisible control                                            |

### Store, platform and tool marks

`StoreBadge` and `PlatformBadge` identify where something lives. The glyphs are generic geometric
marks drawn for this project, not company logos:

| Name               | Glyph                                         | Stands beside                                |
| ------------------ | --------------------------------------------- | -------------------------------------------- |
| `store`            | storefront                                    | any store; the fallback for an unknown value |
| `store-ios`        | shopping bag                                  | App Store, App Store Connect                 |
| `store-android`    | rounded square with a play triangle           | Google Play, Google Play Console             |
| `platform-ios`     | tall phone outline with a top pill            | iOS                                          |
| `platform-android` | rounded square with a 2x2 grid                | Android                                      |
| `platform-macos`   | desktop display with a stand and a bezel line | macOS                                        |
| `send`             | paper plane                                   | TestFlight                                   |
| `repo`             | repository outline                            | GitHub                                       |
| `code`             | code brackets                                 | Expo                                         |
| `pipeline`         | three lanes that fork                         | Fastlane                                     |

```svelte
<StoreBadge store="app_store" variant="full" />   <!-- glyph + "App Store Connect" -->
<StoreBadge store="google_play" />                <!-- chip: glyph + "Google Play" -->
<StoreBadge store="github" variant="icon" />      <!-- glyph only; the glyph carries the title -->
<StoreBadge store="google_play" tone="tinted" />  <!-- the one restrained accent: ok tint -->
<PlatformBadge platform="ios" />                  <!-- tinted tile (own hue per platform) + "iOS"; showLabel={false} keeps the name for screen readers; official logo from src/assets/platforms if added -->
```

Use `lib/stores.ts` instead of repeating strings: `storeForCredentialKind('app_store_connect')`,
`storeForPlatform('android')`, `storeForRepositoryHost('github.com')`, `storeForProjectKind('expo')`
return `{ store, label, fullLabel, icon, tint }`; an unknown value is the neutral generic store (or
the neutral Git host for an unknown repository host).

Tints: only the App Store and Google Play (and TestFlight) can be tinted, with the existing `info`
and `ok` tokens (`-bg`, `-ink`, `-line`), which already pass AA in both themes. The default is
neutral. Do not add a colour per brand. Do not use a tinted store badge next to a status badge of
the same tint without the text, because green and blue also mean "ok" and "info".

### Trademarks

Names and logos of third-party services (Apple App Store, App Store Connect, TestFlight, iOS, Google
Play, Google Play Console, Android, GitHub, Expo, Fastlane) are trademarks of their respective owners,
used only to identify the service. This project is not affiliated with, endorsed by or sponsored by
any of them. The official badges ("Download on the App Store", "Get it on Google Play") must never be
reproduced, and the marks here are small generic glyphs, not logos. See `THIRD_PARTY_NOTICES.md`.

### Adding an icon safely

1. Hand-author it on the 24 x 24 grid in `lib/icons.ts` (`stroke(...)` for a 2px round-stroke
   outline, geometry inside 1..23; `fill(...)` for a solid, closed shape inside 0..24). Only
   `<path d>`, `<circle>` and `<rect>`. Do not paste path data you cannot license.
2. Add its name to `EXPECTED_NAMES` in `lib/icons.test.ts` (that list is the snapshot).
3. Run `pnpm --filter @kiln/web icons:check` (prints each icon's bounding box and fails on invalid
   path grammar or anything outside the viewBox) and `pnpm --filter @kiln/web test`.
4. Look at it in `IconGallery.svelte` in both themes at 14, 16 and 24 px. The checks do not tell you
   whether it looks right.
5. A mark for a third-party brand needs a row in `THIRD_PARTY_NOTICES.md` and an entry in
   `genericBrandIcons` (the test fails without it). A real brand glyph (for example from Simple Icons,
   CC0 data with a trademark caveat) is only acceptable if its exact `d` is copied byte for byte from
   the official repository file, recorded there with URL, commit and licence, and passes the checker.
   Never type brand paths from memory.

To look at the gallery, mount `components/ui/IconGallery.svelte` temporarily (for example in
`src/main.ts`) and run the dev server. It is dev only and nothing imports it.

### Adoption list for screens still being rewritten

These files were not edited when the icon system landed (other work was in progress). Apply them
when that work is merged. `PlatformBadge` (portfolio and ui) already uses the new platform glyphs
everywhere without a change, and `ReleaseStatus` shows its status icon.

| File                                                                                                                                                                                                                 | Where                                                                                                                                                                     | Use                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/release/Rollout.svelte`                                                                                                                                                                                  | `storeSource` (about line 84) and the "Planning only" sentence (about line 221) say "App Store Connect" or "Google Play" in plain text; badges at about lines 255 and 337 | `<StoreBadge store={app_store or google_play} variant="full" size="sm" />` beside the sentence; badges get `toneIcon(tone)` instead of `dot`     |
| `components/release/RolloutObserved.svelte`                                                                                                                                                                          | `source` (about line 17)                                                                                                                                                  | `StoreBadge variant="full" size="sm"` in the header                                                                                              |
| `components/release/ReleaseNotes.svelte`, `NewPlan.svelte`                                                                                                                                                           | Store limits in prose (App Store 4000, Google Play 500)                                                                                                                   | `StoreBadge variant="chip" size="sm"` before each limit                                                                                          |
| `components/release/Checklist.svelte`                                                                                                                                                                                | Required and Optional badges (about line 198)                                                                                                                             | `icon="flag"` on Required                                                                                                                        |
| `components/release/PlatformPanel.svelte`, `components/dashboard/BoardCard.svelte`, `components/dashboard/AttentionStrip.svelte`, `components/portfolio/AppDetail.svelte`, `components/portfolio/BuildsPanel.svelte` | `PlatformBadge`                                                                                                                                                           | Nothing to do. Optionally add `<StoreBadge store={storeForPlatform(platform).store} size="sm" />` on the app header of `AppDetail`               |
| `components/portfolio/BuildsPanel.svelte`                                                                                                                                                                            | "on GitHub" link text (about lines 293 and 335). The link badge has its icon and the tag source has the GitHub glyph                                                      | `Icon name="repo"` before the remaining GitHub text                                                                                              |
| `components/portfolio/BuildsPanelChanges.svelte`, `BuildsPanelConventions.svelte`                                                                                                                                    | "GitHub" in prose and the Found / Not found badges (about lines 352 and 356)                                                                                              | `StoreBadge store="github" size="sm"`; badges `icon="check-circle"` and `icon="alert-triangle"`                                                  |
| `components/ci/CiPanel.svelte`, `RunsTable.svelte`, `DispatchDialog.svelte`, `RunStatus.svelte`                                                                                                                      | "GitHub Actions" headings, the dispatch badge (about line 200), run status                                                                                                | `StoreBadge store="github" variant="chip"` in the card title; `RunStatus` icon from `toneIcon(badge.tone)` (running: `refresh`, queued: `clock`) |
| `components/repositories/RepositoryDetail.svelte`                                                                                                                                                                    | Local only badge (about line 159) and the GitHub button (about line 161)                                                                                                  | `icon="folder"` on the badge; `StoreBadge store="github" variant="icon"` before the repository name                                              |
| `components/repositories/ChangeSetReview.svelte`, `ApplyDialog.svelte`                                                                                                                                               | "Open a pull request on GitHub" and "Push the branch to GitHub"                                                                                                           | `Icon name="git-pull-request"` and `Icon name="git-branch"` before the option label; file-change badges `plus`, `edit`, `trash`                  |
| `components/repositories/LocalCheckoutCard.svelte`, `LocalCheckoutConnect.svelte`, `LocalOutcomeCard.svelte`                                                                                                         | Local clone state badge (about line 185), outcome step badges                                                                                                             | `Icon name="folder"` on the card title; badges `icon={toneIcon(tone)}`                                                                           |
| `components/listing/*`                                                                                                                                                                                               | Source badges in the history drawer, field status badges, "new locale"                                                                                                    | `icon="store-ios"` / `repo` for a store or repo source; `toneIcon(statusTone)`; `icon="language"` on "new locale"                                |
| `components/reviews/*`                                                                                                                                                                                               | Store names in headings and any status badge                                                                                                                              | `StoreBadge variant="chip"`; `toneIcon(tone)` on status badges                                                                                   |

For the navigation, `lib/views.ts` keeps its current icons. A `zap` icon exists if you want the
Webhooks entry to use it; `lib/format.ts` (`eventVisual`) would need the same change so the audit
log agrees.

## Hierarchy and density

**One hierarchy per page** (docs/ux-ia.md 0e): header (app, scope, Sync) > tabs (pages) > range bar > `SectionRail` (sections) | content. Tiles of figures sit in a
uniform grid (equal width and height, `StatRow`); a block without data is one compact line, not an empty column; several platforms are compared in one table
(`CompareTable`) rather than repeated.

Important things are visible first: the screen's data (the locale grid, the review list, the current
releases) starts on the first screen. Everything else is quiet by default: explanations and legends in
`InfoTip`, warnings as a `StatusPill`, history under a `Disclosure`, a switched-off or empty feature as
one slim line. A block with nothing to show is not drawn. Safety UI for store writes (previews,
confirmations, typed phrases) is never shortened; only its idle state is.

## Emails

Emails have their own small token object (`emailTokens` in `apps/server/src/mail/layout.ts`) that mirrors the names and values
of `theme.css` (light and dark, the brand gradient, Space Grotesk / Inter as first font names). Change both when you retheme.
Layout, preview script and client caveats: [emails](emails.md).

## Do

- Use one primary button per view or dialog. Put it last in a row of actions.
- Label every input with a visible `<label>`. Put the rule in `.hint` and the problem in
  `.field-error`; set `aria-invalid` on the input.
- Show a skeleton while a list loads, an empty state when it is empty, an alert when it failed, with
  a retry.
- Confirm destructive actions in a `Modal` or inline, and name the thing being deleted.
- Use `--space-*` for every margin, padding and gap.
- Name icon-only buttons with `aria-label` (or `Button` `label`).

## Don't

- Don't hard-code colors, pixel sizes off the grid, or shadows. Use tokens (a test fails on a hard-coded color).
- Don't use color alone for status. Pair a badge or alert with words.
- Don't use `--ok`, `--bad`, `--warn` or `--info` as text color; use the `-ink` variants.
- Don't style a `div` as a button or a link. Use the element.
- Don't add exclamation marks, emoji or title case ("Add credential", not "Add Credential!").
- Don't disable animation by hand; `prefers-reduced-motion` already does it.
- Don't put a second accent color in a screen. Add a neutral or a status color instead.
- Don't use the brand gradient outside the accents listed under "Where the gradient is used".
