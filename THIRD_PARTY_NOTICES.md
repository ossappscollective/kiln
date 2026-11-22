# Third-party notices

## Icons (apps/web)

Every icon in `apps/web/src/lib/icons.ts` is hand-authored for this project and is covered by the
project's Apache-2.0 licence. No icon font, sprite, CDN file or icon package is used, and no path
data was copied from Lucide, Feather, Simple Icons or any other set. The shapes follow the general
style of open stroke icon sets (24 x 24 grid, 2px round stroke) because that is a common, unowned
convention; the path data is our own.

### Store, platform and tool marks

The UI names several third-party services so that people can tell them apart: Apple App Store and
App Store Connect, TestFlight, iOS, Google Play and Google Play Console, Android, GitHub, Expo and
Fastlane. The names, product marks and logos of these services are trademarks of their respective
owners. They are used only to identify the service. This project is not affiliated with, endorsed by
or sponsored by any of them.

The glyphs that stand beside those names are generic geometric marks drawn for this project. They
are NOT the companies' logos and do not reproduce them. The official full-colour badges ("Download on
the App Store", "Get it on Google Play") are not used anywhere.

| Icon name          | Stands beside                       | What it is                                              |
| ------------------ | ----------------------------------- | ------------------------------------------------------- |
| `store`            | Any store, and the neutral fallback | A storefront with an awning                             |
| `store-ios`        | App Store, App Store Connect        | A plain shopping bag                                    |
| `store-android`    | Google Play, Google Play Console    | A rounded square with a play triangle                   |
| `platform-ios`     | iOS                                 | A phone outline with a top pill and a home bar          |
| `platform-android` | Android                             | A phone outline with a camera dot and a bottom bar      |
| `platform-macos`   | macOS                               | A desktop display outline with a stand and a bezel line |
| `send`             | TestFlight                          | A paper plane                                           |
| `repo`             | GitHub                              | A repository (book) outline                             |
| `code`             | Expo                                | Code brackets and a slash                               |
| `pipeline`         | Fastlane                            | Three lanes that fork                                   |

`apps/web/src/lib/icons.ts` lists the same names in `genericBrandIcons`, and `icons.test.ts` fails if
an entry there is missing from this table.

### Platform logos (apps/web/src/assets/platforms)

`ios.svg` (the "iOS" wordmark), `macos.svg` (the Apple logo) and `android.svg` (the Android robot) are
single-colour paths from Simple Icons (https://simpleicons.org, https://github.com/simple-icons/simple-icons),
whose icon data is released under CC0 1.0. The path data was read from the Iconify mirror of the set
(`simple-icons` collection, 24x24 viewBox) in November 2026 and re-wrapped in a minimal `<svg>`; each was
rendered and compared by eye with the original mark. The commit hash of the set was not available from that
mirror. CC0 covers the drawing only: Apple, iOS, macOS and the Apple logo are trademarks of Apple Inc., and
Android and the Android robot are trademarks of Google LLC. They are used here only to name the platform of an
app, small and without implying endorsement; follow Apple's and Google's trademark guidelines before using
them anywhere larger (marketing, store listings, the website).

### Why there are no other real brand marks

For the generic brand icons, Simple Icons (CC0-1.0 for the icon data, with its own
trademark caveat in the README) would be the usual source of single-colour brand glyphs. The exact
`d` attributes could not be obtained and verified when this was written: the fetch tool available
returns at most a short quoted excerpt of a file, and the repository's raw file host was not
reachable. Brand path data is never typed from memory, so none was added. No Simple Icons data is
included in this repository, and there is no commit hash, date or licence to record for it.

If real brand marks are added later, each one must be recorded here with: the source URL of the file,
the commit hash and date it was read at, its licence, and a statement that it was copied byte for
byte; it must pass `pnpm --filter @kiln/web icons:check`; and the trademark note above applies to it.
See "Adding an icon safely" in `docs/design-system.md`.

## Open Screenshot Generator (logic adapted from its Growth tools)

Some pure logic in Kiln is adapted from the "Growth" tools of Open Screenshot Generator
(https://github.com/dotnetdreamer/open-screenshot-generator, commit dcca453, read 2026-11-22), which is
released under the MIT licence. Kiln is Apache-2.0; the MIT licence allows this when its copyright
notice and permission notice travel with the adapted code, which is why they are repeated here. A file
that is substantially adapted says so in its header comment ("Adapted from Open Screenshot Generator,
MIT"). The code was rewritten for Kiln's own stack (TypeScript on the server and in `packages/core`,
Svelte 5 in `apps/web`) and its data model; the user interface, the wording and every message string
are Kiln's own. No images, icons, fonts, screenshots or templates from that project were copied.

```
MIT License

Copyright (c) 2026 Idrees Khan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
