# Design system

A restrained, enterprise-style system for the web UI (`apps/web`). Quiet surfaces, one accent,
clear type, a strict 4px grid. Nothing here has been rendered in a browser yet; check the screens
by eye when you first run `pnpm --filter @mrm/web dev`.

## Principles

- Content first. Borders and spacing carry the structure; shadows are small and rare.
- One accent. Color means something: blue for action and selection, green, amber, red and blue
  tints for status. Never use color alone; the text or an icon must say the same thing.
- Sentence case, plain words, no exclamation marks, no emoji.
- Keyboard first. Every control has a visible focus ring, a real element and an accessible name.

## Where things live

| What | File |
| --- | --- |
| Color tokens (both themes), as TypeScript | `apps/web/src/lib/tokens.ts` |
| Every token as CSS, plus global styles | `apps/web/src/app.css` |
| Theme choice (Auto, Light, Dark), remembered in `localStorage` | `apps/web/src/lib/theme.ts` |
| Components | `apps/web/src/components/ui/` |
| Toast store | `apps/web/src/lib/toast.svelte.ts` |

`app.css` repeats the hex values of `tokens.ts`. `lib/contrast.test.ts` fails if the two differ, and
checks WCAG AA contrast of the text and graphic pairs listed in `tokens.ts` in both themes. Change a
color in both files, then run `pnpm --filter @mrm/web test`.

## Themes

Light is the default. Dark follows `prefers-color-scheme: dark`. A person can override it with the
theme toggle (Auto, Light, Dark); the choice sets `data-theme="light|dark"` on `<html>` and is saved
under `mrm.theme` (a failure to save is ignored). Write components against the variables below and
they work in both. Never hard-code a color.

## Color tokens

| Group | Variables | Use |
| --- | --- | --- |
| Surfaces | `--ground` `--surface` `--surface-sunken` `--surface-hover` `--surface-active` | Page, cards and inputs, table headers and code, hover, pressed |
| Text | `--ink` `--muted` `--faint` | Body, secondary text and labels, placeholders |
| Borders | `--line` `--line-strong` `--line-hover` | Dividers and cards, control borders, hovered control borders |
| Accent | `--accent` `--accent-hover` `--accent-ink` `--accent-bg` | Primary action, links and focus; text on accent; selected tint |
| Success | `--ok-bg` `--ok-ink` `--ok` `--ok-line` | Tint, text on tint, dot or icon, border |
| Danger | `--bad-bg` `--bad-ink` `--bad` `--bad-line` | Same, for errors and destructive actions |
| Warning | `--warn-bg` `--warn-ink` `--warn` `--warn-line` | Same |
| Info | `--info-bg` `--info-ink` `--info` `--info-line` | Same |
| Solid danger | `--danger-solid` `--danger-solid-hover` `--danger-solid-ink` | The destructive confirm button |
| Misc | `--scrim` `--focus-soft` `--skeleton-from` `--skeleton-to` | Modal backdrop, focus halo, loading shimmer |

Text on a tint uses the matching `-ink` variable. The solid (`--ok`, `--bad`, `--warn`, `--info`) is
for dots, icons and borders only, never for body text.

## Type, space, shape, motion, layers

- Fonts: `--font-sans` (system UI stack) and `--font-mono` (secrets, ids, code). Numbers in tables
  and times use tabular figures automatically (`td`, `time`, `.num`).
- Sizes: `--text-xs` 12, `--text-sm` 13, `--text-base` 14 (body), `--text-md` 16, `--text-lg` 18,
  `--text-xl` 20 (page title), `--text-2xl` 24, `--text-3xl` 30. Weights: 400, 500, 600.
- Space, on a 4px grid: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32, `-10` 40,
  `-12` 48, `-16` 64. Use only these.
- Radii: `--radius-sm` 4, `-md` 6 (controls), `-lg` 8 (cards), `-xl` 12 (dialogs), `-full`.
- Control heights: `--control-sm` 28, `--control-md` 36, `--control-lg` 40.
- Shadows: `--shadow-xs` (controls, cards), `-sm`, `-md` (menus), `-lg` (dialogs, toasts).
- Motion: `--duration-fast` 100ms, `-base` 160ms, `-slow` 240ms, `--ease`. Under
  `prefers-reduced-motion` all animation and transition is cut to nothing.
- Layers: `--z-sticky` 10, `-sidebar` 20, `-dropdown` 30, `-overlay` 40, `-modal` 50, `-toast` 60,
  `-tooltip` 70.
- Layout: `--sidebar-width` 248px, `--topbar-height` 56px, `--content-width` 1120px.

## Global classes (plain markup)

These work without any component. The first group is relied on by existing screens, so do not
rename them.

| Class | Notes |
| --- | --- |
| `button`, `.btn` | Secondary by default. Modifiers: `.primary`, `.danger`, `.primary.danger` (solid), `.ghost`, `.link`, `.bare` (strip the look for custom controls), `.sm`, `.lg`, `.icon` (square), `.block`, `.loading` (spinner, blocks clicks) |
| `input`, `select`, `textarea` | Hover, focus and disabled states. `aria-invalid="true"` shows the error border |
| `.field`, `.hint`, `.field-error`, `.required`, `.check`, `.input-group` | Form layout. `.hint` is helper text, `.field-error` an inline message |
| `.card` | Modifiers `.flush` (no padding) and `.raised`. Parts: `.card-header` |
| `.badge` | Modifiers `.ok` `.bad` `.warn` `.info` `.accent` and `.dot` |
| `.alert` | Modifiers `.error` `.info` `.warn` `.ok`. The icon comes from CSS. Use `role="alert"` for errors, `role="status"` otherwise |
| `table`, `th`, `td` | Row hover. Add `.sticky` to the table inside a `.table-wrap` (scrolling container) for a sticky header, `.compact` for tight rows, `.num` on a cell to right-align numbers, `td.actions` for row buttons |
| `.row`, `.stack`, `.spacer` | Flex row, vertical rhythm (`.stack.tight`, `.stack.loose`), flexible gap |
| `.page-header`, `.page-title`, `.page-desc`, `.page-actions` | The top of a screen |
| `.empty-state` | Centered empty message |
| `.skeleton`, `.spinner` | Loading placeholders |
| `.muted`, `.mono`, `.tabular`, `.eyebrow`, `.truncate`, `.visually-hidden`, `.no-print` | Utilities |

## Components (`components/ui/`)

Each file starts with a comment that lists its props.

| Component | Use it for |
| --- | --- |
| `Button` | Any button or button-styled link. `variant`, `size`, `icon`, `iconOnly` + `label`, `loading`, `block`, `href` |
| `TextField` | A labelled input with hint, inline error and a password reveal toggle |
| `Badge`, `Alert` | Status labels and inline messages |
| `Card`, `PageHeader`, `EmptyState` | Page structure |
| `Spinner`, `Skeleton` | Loading. Prefer a skeleton of the real layout for lists and tables |
| `Modal` | Confirmations and short forms. Native `<dialog>`: focus trap, Escape, focus returns to the opener |
| `ToastHost` + `toast` | Brief confirmation after an action. Mount `ToastHost` once (done in `App.svelte`) and call `toast.success('Saved')` |
| `Tooltip` | A hint for an icon-only control. CSS only, keyboard accessible, Escape hides it |
| `CopyButton` | Copy a value with feedback and a fallback for plain http |
| `Tabs` | Views of one object. Arrow keys move between tabs |
| `ThemeToggle`, `Logo`, `Icon` | Theme choice, the product mark, and about 45 stroke icons (`icons.ts`) |

To show an icon in the navigation, set `icon` on the view in `lib/views.ts`.

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

- Don't hard-code colors, pixel sizes off the grid, or shadows. Use tokens.
- Don't use color alone for status. Pair a badge or alert with words.
- Don't use `--ok`, `--bad`, `--warn` or `--info` as text color; use the `-ink` variants.
- Don't style a `div` as a button or a link. Use the element.
- Don't add exclamation marks, emoji or title case ("Add credential", not "Add Credential!").
- Don't disable animation by hand; `prefers-reduced-motion` already does it.
- Don't put a second accent color in a screen. Add a neutral or a status color instead.
