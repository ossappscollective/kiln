# ADR 0041: One themed token layer for the web look

Status: built. Nothing has been rendered in a browser by the author of this change; the dark and light themes still need a look
by eye (see "Not verified").

## Context

The owner approved a new look for the web app: dark-first deep indigo, one brand gradient (blue, violet, ember: the colors of the
Kiln mark) used sparingly, Space Grotesk for headings and figures and Inter for text, rounder shapes, glows on a few accents. The
explicit requirement was a full CSS style, so the look can be changed later by editing one place.

Before this change the tokens were already custom properties in `app.css`, but the light block, the dark block and the system-dark
block lived in the middle of a 1,400-line file, the chart colors were defined in a scoped style of `VizScope.svelte`, a handful of
components carried their own fallbacks and pixel radii, and the logo drew its own hex colors.

## Decision

1. **`apps/web/src/styles/theme.css` is the one place to retheme.** Tokens only: themed colors (light, dark by choice, dark from the
   system setting), translucent borders, shadows, glows, gradients, fonts, radii, spacing, motion, layers and the chart tokens.
   `app.css` imports it. Token names that components already used (`--ground`, `--surface`, `--ink`, `--accent`, `--line`, ...) are
   kept; new ones are additive (`--sidebar`, `--chip-ink`, `--focus`, `--primary-from/-to`, `--title-end`, `--viz-*`, `--brand-*`,
   `--ring`, `--halo`, `--ambient`, `--shadow-card`, ...).
2. **`styles/accents.css` is the one place the brand gradient is applied as a rule** (primary button, page title and header glow,
   `.accent-edge`). The other gradient accents (sidebar current item, selected segment, chart line, logo, focus ring) read tokens from
   `theme.css` in the files that draw them. The list of allowed accents is in `docs/design-system.md`.
3. **Solid colors stay mirrored in `lib/tokens.ts`** so `contrast.test.ts` can check WCAG AA for every text and graphic pair in both
   themes; the test now reads `theme.css`, also checks that the two dark blocks agree, that the brand stops are what the logo draws,
   and that no component or stylesheet hard-codes a color (exceptions: QR codes, which must be black on white, and the print block).
   Translucent values (borders, glows, shadows) are not solid colors and live only in `theme.css`.
4. **The theme mechanism is unchanged**: `data-theme` on `<html>` or, on Auto, `prefers-color-scheme`. A person keeps the Light,
   Dark and Auto choice. With no system preference the result is light, as before.
5. **Fonts are not downloaded.** The server's CSP is `default-src 'self'` and the product avoids third-party requests, so no Google
   Fonts link. `--font-display` is `"Space Grotesk"` and `--font-sans` starts with `Inter`, both falling back to the system UI stack;
   self-hosting the files is a documented step, not part of this change.
6. **Glows are decorative**: backgrounds and pseudo-elements only, no content; the existing reduced-motion rule still cuts all
   animation.

## Consequences

- Changing the gradient, the radii, the fonts or a color is an edit to one file (and the matching line of `tokens.ts` for a solid
  color); the contrast test says at once if a pair stops being readable.
- Radii grew (controls 12px, cards 18px, dialogs 20px), so every component that used `--radius-md` or `--radius-lg` is rounder
  without being edited.
- A single-series chart line is drawn with a gradient, a blurred glow copy and an area fill; with two series the lines stay solid so
  the legend can tell them apart.
- `VizScope.svelte` no longer holds the chart colors; it stays as the wrapper of the chart screens.

## Not verified

- No page was rendered. Build and type checks pass; contrast is computed, not eyeballed.
- The light theme's gradient ends and glows are tuned for contrast on paper and have not been seen.
- The desktop window has no background color of its own (the window is built in Rust); a dark window background would avoid a white
  flash while the page loads, and needs a change in `apps/desktop/src-tauri/src/main.rs`.
