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

| Icon name | Stands beside | What it is |
| --- | --- | --- |
| `store` | Any store, and the neutral fallback | A storefront with an awning |
| `store-ios` | App Store, App Store Connect | A plain shopping bag |
| `store-android` | Google Play, Google Play Console | A rounded square with a play triangle |
| `platform-ios` | iOS | A phone outline with a top pill and a home bar |
| `platform-android` | Android | A phone outline with a camera dot and a bottom bar |
| `send` | TestFlight | A paper plane |
| `repo` | GitHub | A repository (book) outline |
| `code` | Expo | Code brackets and a slash |
| `pipeline` | Fastlane | Three lanes that fork |

`apps/web/src/lib/icons.ts` lists the same names in `genericBrandIcons`, and `icons.test.ts` fails if
an entry there is missing from this table.

### Why there are no real brand marks

Simple Icons (https://github.com/simple-icons/simple-icons, CC0-1.0 for the icon data, with its own
trademark caveat in the README) would be the usual source of single-colour brand glyphs. The exact
`d` attributes could not be obtained and verified when this was written: the fetch tool available
returns at most a short quoted excerpt of a file, and the repository's raw file host was not
reachable. Brand path data is never typed from memory, so none was added. No Simple Icons data is
included in this repository, and there is no commit hash, date or licence to record for it.

If real brand marks are added later, each one must be recorded here with: the source URL of the file,
the commit hash and date it was read at, its licence, and a statement that it was copied byte for
byte; it must pass `pnpm --filter @mrm/web icons:check`; and the trademark note above applies to it.
See "Adding an icon safely" in `docs/design-system.md`.
