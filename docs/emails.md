# HTML emails

Every HTML email the server sends (alert emails, the alert digest, the sign-in / step-up / address-verification codes, the SMTP
test message) is built from one module: `apps/server/src/mail/layout.ts`. The plain-text part of each email is separate and
unchanged. All sentences come from the `email`, `alerts` and `digest` catalogs (docs/i18n-server.md).

## Where things live

| What                                                                                                                                                                                        | Where                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Tokens (colours per scheme, brand colours, fonts, radii, width)                                                                                                                             | `emailTokens` at the top of `mail/layout.ts` |
| Helpers: `emailShell`, `emailHeading`, `emailParagraph`, `emailButton`, `emailCodeBox`, `emailKeyValueRows`, `emailCalloutHtml`, `emailChip`, `emailDivider`, `emailFooter`, `emailItemRow` | `mail/layout.ts`                             |
| Link origin (`KILN_PUBLIC_ORIGIN`) and `escapeHtml`                                                                                                                                         | `services/mail-template.ts`                  |
| Alert emails and digest                                                                                                                                                                     | `modules/alerts/email.ts`                    |
| Codes                                                                                                                                                                                       | `codeMessage` in `services/two-factor.ts`    |
| SMTP test                                                                                                                                                                                   | `testMessageHtml` in `routes/mail.ts`        |

Helpers take plain text and escape it; a name ending in `Html` takes HTML the caller already escaped with `escapeHtml`.

## Retheme in one place

Edit `emailTokens` (names mirror `apps/web/src/styles/theme.css`: `ground`, `surface`, `sunken`, `ink`, `muted`, `accent`,
`primaryFrom/To`, tones). Change a helper to change structure. `mail/layout.test.ts` checks the contrast of every text pair of both
schemes (4.5:1) from the tokens, so a bad colour fails the tests. New templates must only use the helpers: no hard-coded colours.

## Preview

```
pnpm email:preview                       # every email, English, into ./.email-preview (git-ignored)
node scripts/email-preview.mjs --lang fr --out /tmp/mails --no-links
```

Open `.email-preview/index.html`. Dark mode: switch the OS or the browser's emulated `prefers-color-scheme`.

## Client caveats

No real mail client rendering has been checked; the preview is a browser. The design assumes the worst case and degrades:

- Layout is tables with inline styles. The `<style>` block only adds the dark scheme (`prefers-color-scheme`, with `!important`) and
  a mobile padding rule; clients that strip `<style>` (some Gmail setups) show the light version.
- Gradients (accent bar, primary button) always have a solid colour underneath (`bgcolor` and `background-color`). Outlook for
  Windows ignores `linear-gradient` and `border-radius`: it shows square, solid blocks. Gmail and Apple Mail show the gradient.
- Dark mode: Apple Mail and recent Outlook honour `prefers-color-scheme`. Gmail apps and Outlook.com may instead auto-invert colours
  and ignore the media query. The header band is dark indigo in both schemes so the wordmark never changes background.
- No web fonts, images or SVG (blocked by Gmail and Outlook). Space Grotesk and Inter are only first names in the font stack; the
  fallback is the system UI font. The logo is text plus three coloured table cells.
- The button is a table cell with a 44px-high link; Outlook gets the padding through `mso-padding-alt`, not a VML button.
- The hidden preheader is a `display:none` span; clients show its text beside the subject.
