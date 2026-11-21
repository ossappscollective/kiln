# Spike: Expo `store.config.json` (EAS Metadata)

**Question:** what does `store.config.json` hold, how does it map to the listing model in
`@kiln/core`, and what can be written back safely?

**Status:** the schema was checked on 2026-11-18 against the pages below. Anything under "Not
verified" is a guess in the code (a warning, not an error). Code: `packages/connectors/src/expo-store.ts`.

## What was verified, with the page

Sources: [EAS Metadata](https://docs.expo.dev/eas/metadata/),
[getting started](https://docs.expo.dev/eas/metadata/getting-started/),
[schema](https://docs.expo.dev/eas/metadata/schema/) (also served as
`https://docs.expo.dev/eas/metadata/schema.md`), and the JSON schema shipped in
[eas-cli 19.1.0](https://cdn.jsdelivr.net/npm/eas-cli@19.1.0/schema/metadata-0.json).

- **Beta.** "Expo Metadata is in beta and subject to breaking changes."
- **Apple only.** Getting started: it "currently only supports the Apple App Store". The overview
  FAQ says Google Play "is one of those features currently not implemented", and its comparison
  table marks Play listing management as not supported. The schema has only an `apple` section.
  So there is **no Google Play support**: nothing in this file can hold a Play listing, and the
  code never produces `Listing.googlePlay` from it and refuses to write one (a warning).
- **File.** `store.config.json` in the project root by default; `eas.json` `metadataPath` changes
  name and location (this page does not show the value format). A dynamic store config (async
  functions) is also supported; the code never runs it. `eas metadata:pull` imports the stores'
  data into the file and `eas metadata:push` uploads it.
- **Top level** (JSON schema): `configVersion` (only `0`) and `apple`, both required,
  `additionalProperties: false`.
- **`apple`** (JSON schema, no required keys, `additionalProperties: false`): `version`,
  `copyright`, `advisory`, `categories`, `info`, `release`, `review`, `appClip`. The docs page
  lists `version` and `copyright` in a table without showing where they nest; the JSON schema puts
  both directly under `apple`, and the code follows the JSON schema. `appClip` is only in the JSON
  schema, not on the docs page.
- **`apple.info.<locale>`**: keys are fixed. 39 locale codes, no pattern: `ar-SA ca zh-Hans zh-Hant
  hr cs da nl-NL en-AU en-CA en-GB en-US fi fr-FR fr-CA de-DE el he hi hu id it ja ko ms no pl pt-BR
  pt-PT ro ru sk es-MX es-ES sv th tr uk vi` (`EXPO_LOCALES`). Per locale, `additionalProperties:
  false`:

  | Key                       | Type                     | Limit in the schema   | Required in the schema |
  | ------------------------- | ------------------------ | --------------------- | ---------------------- |
  | `title`                   | string                   | 2 to 30               | yes                    |
  | `subtitle`                | string                   | 30                    | no                     |
  | `description`             | string                   | 10 to 4000            | no                     |
  | `keywords`                | array of strings, unique | each item at most 100 | no                     |
  | `releaseNotes`            | string                   | 4000                  | no                     |
  | `promoText`               | string                   | 170                   | no                     |
  | `marketingUrl`            | string                   | 255                   | no                     |
  | `supportUrl`              | string                   | 255                   | no                     |
  | `privacyPolicyUrl`        | string                   | 255                   | yes                    |
  | `privacyPolicyText`       | string                   | none (Apple TV)       | no                     |
  | `privacyChoicesUrl`       | string                   | 255                   | no                     |
  | `screenshots`, `previews` | objects                  |                       | no (JSON schema only)  |

- **`apple.release`**: `automaticRelease` (boolean or RFC 3339 date-time) and `phasedRelease`
  (boolean). **`apple.review`**: `firstName`, `lastName`, `email`, `phone`, `demoUsername`,
  `demoPassword`, `demoRequired`, `notes`. Neither is part of the listing model.
- The `title`, `subtitle`, `description`, `releaseNotes` and `promoText` limits equal the limits
  `@kiln/core` already uses, so reusing `validateListing` gives the same answers as the schema for
  those fields.

## Mapping

| `store.config.json`                              | `@kiln/core` field                             |
| ------------------------------------------------ | --------------------------------------------- |
| `apple.info.<l>.title`                           | `name`                                        |
| `subtitle`, `description`                        | `subtitle`, `description`                     |
| `keywords` (array)                               | `keywords` (joined with `,`, no space)        |
| `releaseNotes`, `promoText`                      | `release_notes`, `promotional_text`           |
| `marketingUrl`, `supportUrl`, `privacyPolicyUrl` | `marketing_url`, `support_url`, `privacy_url` |
| `privacyPolicyText`                              | `apple_tv_privacy_policy`                     |
| `apple.copyright`                                | `copyright`                                   |

Not covered, kept as found and reported in `uncovered`: `apple.version`, `advisory`, `categories`,
`release`, `review`, `appClip`, and per locale `privacyChoicesUrl`, `screenshots`, `previews`.
Keys that are not in the schema at all (including a locale code outside the 39) are reported in
`unknown` and also left alone. `$schema` is ignored silently (editor convention).

## How writing works

The JSON text is edited in place, one value at a time, using the positions of the values. A value
that did not change is not touched. So key order, unrelated keys, indentation (2 spaces, tabs, or
a single line), CRLF and the trailing newline are exactly as found. Added members copy the file's
indentation and keyword array layout (inline or one per line); 2 spaces and inline when the file
gives no hint. New members go at the end of their object, in the order the docs list the keys.
Removed values take their comma with them; a locale emptied of modeled keys is removed. The result
must parse as JSON or nothing is returned.

## Not verified

- **How EAS joins keywords on push.** The model uses one comma separated string (like fastlane).
  The 100 limit in the schema is per keyword; Apple's 100 bytes is for the whole field. Core
  measures the whole joined string in UTF-8 bytes, which is stricter than the schema. Whether
  EAS joins with `,` or `, ` is not stated, so the byte count may be off by the spaces.
- **Whether `eas metadata:push` rejects keys outside the schema.** The JSON schema says
  `additionalProperties: false`; no page says the CLI validates against it, or whether `$schema`
  is accepted. Unknown keys are only warned about.
- **Required fields.** The JSON schema requires `title` and `privacyPolicyUrl`; it does not require
  `supportUrl`, `description` or `copyright`. Core marks Support URL, Description and Copyright as
  required for the App Store (from Apple's pages), so a minimal file like the docs example
  validates with problems (it has no copyright). That is core's rule, not the schema's.
- **The `subtitle` row** reads "length 30" on the docs page; read as a maximum, as in the JSON
  schema (`maxLength: 30`).
- **Placement of `version` and `copyright`** on the docs page (see above): taken from the JSON
  schema only.
- **Newer schema versions.** Only `configVersion: 0` is documented. The eas-cli version above was
  the one the search turned up, not necessarily the latest.
- **Pages were read through a summarizing fetch tool**, not as raw text. The locale list and the
  `required`/`maxLength` values come from that reading of the JSON schema; check them against the
  file (`eas-cli/schema/metadata-0.json`) when it matters.
- **`.ts`, `.cjs`, `.mjs` store configs**: still only `.json` and `.js` are documented; see
  repo-conventions.md. Dynamic configs are never read.
- **Hand-written fixtures**, not recorded from `eas metadata:pull`.

## Using it from the server

```ts
const detection = await detectProject(paths, readFile); // existing
const snapshot = await loadExpoStoreConfig(detection, readFile); // undefined: no JSON store config
if (snapshot?.error) {
  /* not valid JSON or unreadable: show snapshot.error, no edit possible */
}
const problems = validateExpoStoreConfig(snapshot); // same ListingProblem[] as fastlane
// edit snapshot.listing.appStore, then:
const { changes, warnings } = expoStoreChangeSet(snapshot, edited); // changes: FileChange[] (0 or 1 file)
```

`changes` goes into the change set like `listingChangeSet` output.

**Decision (server, `apps/server/src/modules/listing/sources.ts`).** When a repository has a JSON
store config as `detectProject` reports it, that file is the App Store listing source and the
fastlane App Store metadata is ignored (and reported as such); without one, fastlane is the App
Store source. Google Play is always fastlane (EAS Metadata has no Play support). The two are never
merged, and a change set writes only the chosen source's files. A store config that cannot be
read (invalid JSON) is reported on the listing and blocks App Store edits; it does not fall back to
fastlane. Note that `store.config.json` is only picked up when detection sees an Expo project
(an `expo` dependency or an app config), so a lone file is not enough. See
docs/api/repositories.md.
