/**
 * Hand-written repository file lists that model three fastlane layouts seen in real projects
 * (a NativeScript app with `fastlane/metadata/ios`, a monorepo with one metadata folder per app
 * id, and an Android only app). The names are fictional and every text is made up; only the folder
 * structure follows the real projects. Not recordings of live traffic.
 *
 * Each function returns a map of path to file text, so a test can use `Object.keys` as the file
 * list and the values as what a reader returns.
 */

export type RepoFiles = Record<string, string>;

/** Release note files: `1.txt` .. `<count>.txt` under `<dir>/changelogs/`. */
function changelogs(dir: string, count: number): RepoFiles {
  const files: RepoFiles = {};
  for (let code = 1; code <= count; code++) {
    files[`${dir}/changelogs/${code}.txt`] = `Release ${code}: fixes and small changes.\n`;
  }
  return files;
}

type PlayLocale = { locale: string; changelogs: number; video?: boolean; full?: boolean };

/** `<root>/<locale>/{title,short_description,full_description,video}.txt` and release notes. */
function playFolder(root: string, locales: PlayLocale[], name: string): RepoFiles {
  const files: RepoFiles = {};
  for (const l of locales) {
    const dir = `${root}/${l.locale}`;
    files[`${dir}/title.txt`] = `${name}\n`;
    files[`${dir}/short_description.txt`] = `${name}: short text (${l.locale}).\n`;
    if (l.full !== false)
      files[`${dir}/full_description.txt`] = `${name}: longer text (${l.locale}).\n`;
    if (l.video) files[`${dir}/video.txt`] = 'https://example.com/video\n';
    files[`${dir}/images/icon.png`] = 'binary';
    files[`${dir}/images/featureGraphic.png`] = 'binary';
    files[`${dir}/images/phoneScreenshots/1.png`] = 'binary';
    Object.assign(files, l.changelogs > 0 ? changelogs(dir, l.changelogs) : {});
  }
  return files;
}

/** `<root>/<locale>/<field>.txt`, the files outside locales, review information and screenshots. */
function appleFolder(root: string, locales: string[], name: string, full = true): RepoFiles {
  const files: RepoFiles = {};
  for (const locale of locales) {
    const dir = `${root}/${locale}`;
    files[`${dir}/name.txt`] = `${name}\n`;
    files[`${dir}/description.txt`] = `${name} does something useful for you.\n`;
    if (!full) continue;
    files[`${dir}/subtitle.txt`] = 'A short subtitle\n';
    files[`${dir}/keywords.txt`] = 'example,sample,demo\n';
    files[`${dir}/promotional_text.txt`] = 'New and improved.\n';
    files[`${dir}/release_notes.txt`] = 'Bug fixes.\n';
    files[`${dir}/marketing_url.txt`] = 'https://example.com\n';
    files[`${dir}/support_url.txt`] = 'https://example.com/support\n';
    files[`${dir}/privacy_url.txt`] = 'https://example.com/privacy\n';
    files[`${dir}/apple_tv_privacy_policy.txt`] = '\n';
    files[`${root}/screenshots/${locale}/1_iphone.png`] = 'binary';
  }
  if (full) {
    files[`${root}/copyright.txt`] = '2026 Example, Inc.\n';
    files[`${root}/primary_category.txt`] = 'UTILITIES\n';
    files[`${root}/secondary_category.txt`] = 'WEATHER\n';
    files[`${root}/primary_first_sub_category.txt`] = '\n';
    files[`${root}/review_information/first_name.txt`] = 'Ada\n';
    files[`${root}/review_information/last_name.txt`] = 'Example\n';
    files[`${root}/review_information/notes.txt`] = 'No account is needed.\n';
    files[`${root}/review_information/demo_user.txt`] = 'demo\n';
    files[`${root}/screenshots/README.txt`] = 'Screenshots go here.\n';
  }
  return files;
}

const PACKAGE_JSON =
  '{ "name": "example-app", "dependencies": { "@nativescript/core": "^8.0.0" } }\n';
const APPFILE = [
  'app_identifier(ENV["APP_ID"])',
  'package_name(ENV["APP_ID"])',
  'apple_id(ENV["APPLE_IDENTITY_ID"])',
  '',
].join('\n');
const DELIVERFILE_COMMENTS_ONLY = [
  '# The Deliverfile allows you to store various App Store Connect metadata',
  '# For more information, check out the docs',
  '',
].join('\n');

/**
 * The fastlane lanes of these projects take the metadata folder from a variable that defaults to
 * `metadata` and join the platform name onto it, so the path is not a plain string.
 */
const FASTFILE_JOINED = [
  'fastlane_version "2.135.2"',
  'project_root_path = Pathname.new("../").realpath.to_s',
  'metadata_path = ENV["SUPPLY_METADATA_PATH"] || "metadata"',
  'metadata_path_realpath = File.join(project_root_path, "fastlane", metadata_path)',
  '',
  'platform :ios do',
  '  lane :release do |options|',
  '    upload_to_app_store(',
  '      metadata_path: File.join(metadata_path_realpath, "ios"),',
  '      screenshots_path: File.join(metadata_path_realpath, "ios", "screenshots"),',
  '      skip_metadata: !options[:upload_metadata]',
  '    )',
  '  end',
  'end',
  '',
  'platform :android do',
  '  lane :release do |options|',
  '    upload_to_play_store(',
  '      metadata_path: File.join(metadata_path_realpath, "android"),',
  '      skip_upload_metadata: !options[:upload_metadata]',
  '    )',
  '  end',
  'end',
  '',
].join('\n');

/**
 * Layout a): one app, `fastlane/metadata/ios/<locale>/...` and `fastlane/metadata/android/<locale>/...`.
 * The iOS root is `fastlane/metadata/ios`, not `fastlane/metadata`.
 */
export function weatherApp(
  options: { enChangelogs?: number; frChangelogs?: number } = {},
): RepoFiles {
  const { enChangelogs = 145, frChangelogs = 141 } = options;
  return {
    'package.json': PACKAGE_JSON,
    'fastlane/Appfile': APPFILE,
    'fastlane/Deliverfile': DELIVERFILE_COMMENTS_ONLY,
    'fastlane/Fastfile': FASTFILE_JOINED,
    ...appleFolder('fastlane/metadata/ios', ['en-US'], 'Example Weather'),
    ...playFolder(
      'fastlane/metadata/android',
      [
        { locale: 'en-US', changelogs: enChangelogs, video: true },
        { locale: 'fr-FR', changelogs: frChangelogs, video: true },
        { locale: 'de-DE', changelogs: 0, full: false },
      ],
      'Example Weather',
    ),
  };
}

export const CARD_APP = 'com.example.cardwallet';
export const SCAN_APP = 'com.example.documentscanner';

/**
 * Layout b): a monorepo with several apps, one metadata folder per app id:
 * `fastlane/metadata/<app id>/ios/<locale>/...` and `fastlane/metadata/<app id>/android/<locale>/...`.
 */
export function scannerMonorepo(
  options: { cardChangelogs?: number; scanChangelogs?: number } = {},
): RepoFiles {
  const { cardChangelogs = 81, scanChangelogs = 155 } = options;
  return {
    'package.json': PACKAGE_JSON,
    'fastlane/Appfile': APPFILE,
    'fastlane/Deliverfile': DELIVERFILE_COMMENTS_ONLY,
    'fastlane/Fastfile': FASTFILE_JOINED,
    ...appleFolder(`fastlane/metadata/${CARD_APP}/ios`, ['en-US'], 'Example Cards', false),
    ...playFolder(
      `fastlane/metadata/${CARD_APP}/android`,
      [
        { locale: 'en-US', changelogs: cardChangelogs },
        { locale: 'fr-FR', changelogs: 0 },
      ],
      'Example Cards',
    ),
    ...appleFolder(`fastlane/metadata/${SCAN_APP}/ios`, ['en-US'], 'Example Scanner'),
    ...playFolder(
      `fastlane/metadata/${SCAN_APP}/android`,
      [
        { locale: 'en-US', changelogs: scanChangelogs },
        { locale: 'fr-FR', changelogs: 0 },
        { locale: 'de-DE', changelogs: 0, full: false },
      ],
      'Example Scanner',
    ),
  };
}

/** Layout c): Android only, `fastlane/metadata/android/<locale>/...`, no Deliverfile. */
export function mapsApp(options: { enChangelogs?: number; frChangelogs?: number } = {}): RepoFiles {
  const { enChangelogs = 71, frChangelogs = 57 } = options;
  return {
    'package.json': PACKAGE_JSON,
    'fastlane/Appfile': APPFILE,
    'fastlane/Fastfile': FASTFILE_JOINED,
    ...playFolder(
      'fastlane/metadata/android',
      [
        { locale: 'en-US', changelogs: enChangelogs, video: true },
        { locale: 'fr-FR', changelogs: frChangelogs, video: true },
        { locale: 'de-DE', changelogs: 0, full: false },
      ],
      'Example Maps',
    ),
  };
}
