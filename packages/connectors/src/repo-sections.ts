import type {
  ListingAgeRating,
  ListingCategories,
  ListingMedia,
  ListingPrivacy,
  ListingSections,
  MediaSet,
} from '@mrm/core';
import { type FileMap, isLocaleDir, type ListingRoots } from './fastlane.ts';
import { PLAY_GRAPHIC_TYPES, PLAY_SCREENSHOT_TYPES } from './store-sections.ts';

/**
 * The repository side of the listing sections: what fastlane's metadata and screenshot folders and
 * Expo's `store.config.json` can say about categories, the age rating, the privacy choices URL and
 * media. Pure, and strictly read-only: nothing is written, and image files are never read (media is
 * counted from the file paths alone).
 *
 * What each source can express (a section the source cannot express is left out: "not read", and
 * the comparison says "not comparable" instead of guessing):
 *
 * - fastlane `deliver` (docs: https://docs.fastlane.tools/actions/deliver/): non-localized files in the
 *   metadata folder `primary_category.txt`, `secondary_category.txt`, `primary_first_sub_category.txt`,
 *   `primary_second_sub_category.txt`, `secondary_first_sub_category.txt`,
 *   `secondary_second_sub_category.txt`; the age rating answers in a JSON file whose path the
 *   `app_rating_config_path` option names (fastlane's docs give no fixed name; this tool looks for a file named
 *   `app_rating_config.json`); screenshots in `screenshots_path` (default `./fastlane/screenshots`),
 *   one folder per language, the device type detected from the image size (so only a total per
 *   locale is known here). `privacy_url.txt` is a text field of the listing already. The privacy
 *   CHOICES url has no fastlane file.
 * - fastlane `supply` (Google Play): `<locale>/images/{phoneScreenshots,sevenInchScreenshots,
 *   tenInchScreenshots,tvScreenshots,wearScreenshots}/` and `<locale>/images/{icon,featureGraphic,
 *   tvBanner}.png` (https://docs.fastlane.tools/actions/supply/). No categories (the Play Developer
 *   API has none).
 * - Expo `store.config.json` (https://docs.expo.dev/eas/metadata/schema/): `apple.categories`,
 *   `apple.advisory` (the age rating answers, in the API's own names), `apple.info.<locale>.privacyChoicesUrl`.
 *   EAS Metadata documents no screenshot or media fields.
 */

const IMAGE = /\.(png|jpe?g)$/i;

const SUB_FILES = [
  ['primary', 'primary_category.txt'],
  ['secondary', 'secondary_category.txt'],
] as const;
const SUBCATEGORY_FILES = [
  ['primarySubcategories', 0, 'primary_first_sub_category.txt'],
  ['primarySubcategories', 1, 'primary_second_sub_category.txt'],
  ['secondarySubcategories', 0, 'secondary_first_sub_category.txt'],
  ['secondarySubcategories', 1, 'secondary_second_sub_category.txt'],
] as const;

/** The file name of the age rating answers this tool looks for (`app_rating_config_path` has no default name). */
export const FASTLANE_AGE_RATING_FILE = 'app_rating_config.json';

const dirName = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** The folder and its parents, nearest first, up to `levels` of them (a root with no parent ends at ''). */
function ancestors(root: string, levels: number): string[] {
  const out: string[] = [];
  let dir = root;
  for (let i = 0; i < levels; i++) {
    out.push(dir);
    if (dir === '') break;
    dir = dirName(dir);
  }
  return out;
}

/** Where the age rating file is: the nearest folder above the metadata root that has one. */
function ageRatingPath(paths: readonly string[], root: string): string | undefined {
  const set = new Set(paths);
  for (const dir of ancestors(root, 4)) {
    const candidate = join(dir, FASTLANE_AGE_RATING_FILE);
    if (set.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The files `readFastlaneSections` needs the text of: the category files and the age rating file,
 * of the App Store root. Few and small. Screenshots and images are never read.
 */
export function fastlaneSectionFiles(paths: readonly string[], roots: ListingRoots): string[] {
  if (roots.appStore === '') return [];
  const set = new Set(paths);
  const wanted = [
    ...SUB_FILES.map(([, name]) => name),
    ...SUBCATEGORY_FILES.map(([, , name]) => name),
  ]
    .map((name) => join(roots.appStore, name))
    .filter((path) => set.has(path));
  const rating = ageRatingPath(paths, roots.appStore);
  return rating ? [...wanted, rating] : wanted;
}

const firstLine = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const line = raw.replace(/^﻿/, '').split(/\r?\n/)[0]?.trim();
  return line === undefined || line === '' ? undefined : line;
};

/** App Store categories from fastlane's files; `{}` when the folder has none (read, empty). */
export function fastlaneCategories(files: FileMap, root: string): ListingCategories {
  const out: ListingCategories = {};
  for (const [key, name] of SUB_FILES) {
    const value = firstLine(files[join(root, name)]);
    if (value !== undefined) out[key] = value;
  }
  for (const [key, index, name] of SUBCATEGORY_FILES) {
    const value = firstLine(files[join(root, name)]);
    if (value === undefined) continue;
    const list = (out[key] ??= []);
    list[index] = value;
  }
  for (const key of ['primarySubcategories', 'secondarySubcategories'] as const) {
    const list = out[key];
    if (list) out[key] = list.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/**
 * The age rating answers of an `app_rating_config.json`-style file: every member that is a boolean,
 * a string or a number (a number is kept as text: fastlane's older files use 0, 1 and 2). Anything
 * else is ignored. `undefined` when the text is not a JSON object (then the section is not read).
 */
export function parseAgeRatingFile(raw: string): ListingAgeRating | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const answers: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>).slice(0, 200)) {
    if (typeof value === 'boolean') answers[key] = value;
    else if (typeof value === 'string') answers[key] = value.slice(0, 100);
    else if (typeof value === 'number' && Number.isFinite(value)) answers[key] = String(value);
  }
  return { answers };
}

type ByLocale = Map<string, number>;

/** Image files directly or deeply under `<dir>/<locale>/`, counted per locale. */
function countScreenshotFolders(paths: readonly string[], dir: string): ByLocale {
  const prefix = dir === '' ? '' : `${dir}/`;
  const counts: ByLocale = new Map();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('/');
    const locale = parts[0] ?? '';
    if (parts.length < 2 || !isLocaleDir(locale) || !IMAGE.test(parts[parts.length - 1] ?? ''))
      continue;
    counts.set(locale, (counts.get(locale) ?? 0) + 1);
  }
  return counts;
}

/**
 * App Store screenshots of a fastlane repository, counted per locale from paths (`screenshots/<locale>/...`
 * beside the metadata folder, or one or two levels higher, or inside it). The device type is not known (fastlane
 * detects it from the image size, which is not read), so each locale has one set of type `all`.
 * `{ screenshots: {} }` when no such folder has an image (read, empty).
 */
export function fastlaneAppStoreMedia(paths: readonly string[], root: string): ListingMedia {
  // Beside the metadata folder first (fastlane's default `screenshots_path`), then higher, then inside it.
  for (const dir of [...ancestors(root, 3).slice(1), root]) {
    const counts = countScreenshotFolders(paths, join(dir, 'screenshots'));
    if (counts.size === 0) continue;
    const screenshots: Record<string, MediaSet[]> = {};
    for (const [locale, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      screenshots[locale] = [{ type: 'all', count }];
    }
    return { screenshots };
  }
  return { screenshots: {} };
}

/** Google Play images of a supply repository, counted per locale and image type from paths alone. */
export function fastlanePlayMedia(paths: readonly string[], root: string): ListingMedia {
  const prefix = `${root}/`;
  const screenshots = new Map<string, Map<string, number>>();
  const graphics = new Map<string, Map<string, number>>();
  const bump = (into: Map<string, Map<string, number>>, locale: string, type: string) => {
    const inner = into.get(locale) ?? new Map<string, number>();
    inner.set(type, (inner.get(type) ?? 0) + 1);
    into.set(locale, inner);
  };
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('/');
    const [locale, images, third, fourth] = parts;
    if (!locale || !isLocaleDir(locale) || images !== 'images') continue;
    if (
      parts.length === 4 &&
      IMAGE.test(fourth ?? '') &&
      (PLAY_SCREENSHOT_TYPES as readonly string[]).includes(third ?? '')
    ) {
      bump(screenshots, locale, third as string);
    } else if (parts.length === 3 && IMAGE.test(third ?? '')) {
      const name = (third as string).replace(IMAGE, '');
      if ((PLAY_GRAPHIC_TYPES as readonly string[]).includes(name)) bump(graphics, locale, name);
    }
  }
  const toSets = (from: Map<string, Map<string, number>>, types: readonly string[]) => {
    const out: Record<string, MediaSet[]> = {};
    for (const locale of [...from.keys()].sort()) {
      const inner = from.get(locale) as Map<string, number>;
      out[locale] = types.map((type) => ({ type, count: inner.get(type) ?? 0 }));
    }
    return out;
  };
  const media: ListingMedia = { screenshots: toSets(screenshots, PLAY_SCREENSHOT_TYPES) };
  if (graphics.size > 0) media.graphics = toSets(graphics, PLAY_GRAPHIC_TYPES);
  return media;
}

export type RepoSections = {
  appStore: ListingSections;
  googlePlay: ListingSections;
  warnings: string[];
};

/**
 * The sections the fastlane folders can express. `files` holds the text of `fastlaneSectionFiles`.
 * A store whose root is not set gets no sections at all.
 */
export function readFastlaneSections(
  paths: readonly string[],
  roots: ListingRoots,
  files: FileMap,
): RepoSections {
  const out: RepoSections = { appStore: {}, googlePlay: {}, warnings: [] };
  if (roots.appStore !== '') {
    out.appStore.categories = fastlaneCategories(files, roots.appStore);
    const ratingPath = ageRatingPath(paths, roots.appStore);
    if (ratingPath === undefined) {
      out.appStore.ageRating = { answers: {} };
    } else {
      const rating = parseAgeRatingFile(files[ratingPath] ?? '');
      if (rating) out.appStore.ageRating = rating;
      else
        out.warnings.push(
          `${ratingPath} is not a JSON object, so the age rating of the repository was not read.`,
        );
    }
    out.appStore.media = fastlaneAppStoreMedia(paths, roots.appStore);
  }
  if (roots.googlePlay !== '') out.googlePlay.media = fastlanePlayMedia(paths, roots.googlePlay);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expo

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One entry of `apple.categories`: a name, or an array of the category followed by its subcategories. */
function categoryEntry(value: unknown): { name?: string; subs: string[] } {
  if (typeof value === 'string') return { name: value, subs: [] };
  if (Array.isArray(value)) {
    const [name, ...subs] = value;
    return {
      ...(typeof name === 'string' ? { name } : {}),
      subs: subs.filter((s): s is string => typeof s === 'string').slice(0, 2),
    };
  }
  return { subs: [] };
}

/**
 * The sections of an Expo `store.config.json` text: `apple.categories` (the first entry is the primary
 * category, the second the secondary; an entry is a name or `[name, subcategory, subcategory]`),
 * `apple.advisory` (the age rating answers, as they are named in App Store Connect's
 * `ageRatingDeclarations`) and `apple.info.<locale>.privacyChoicesUrl`. Never throws: text that is
 * not a JSON object gives no sections. Media is not expressible (EAS Metadata documents none).
 */
export function expoSections(text: string): ListingSections {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return {};
  }
  const apple = isObject(parsed) && isObject(parsed.apple) ? parsed.apple : undefined;
  if (!apple) return {};
  const sections: ListingSections = {};

  const categories: ListingCategories = {};
  if (Array.isArray(apple.categories)) {
    const primary = categoryEntry(apple.categories[0]);
    const secondary = categoryEntry(apple.categories[1]);
    if (primary.name !== undefined) categories.primary = primary.name;
    if (secondary.name !== undefined) categories.secondary = secondary.name;
    if (primary.subs.length > 0) categories.primarySubcategories = primary.subs;
    if (secondary.subs.length > 0) categories.secondarySubcategories = secondary.subs;
  }
  sections.categories = categories;

  const answers: Record<string, string | boolean> = {};
  if (isObject(apple.advisory)) {
    for (const [key, value] of Object.entries(apple.advisory).slice(0, 100)) {
      if (typeof value === 'boolean') answers[key] = value;
      else if (typeof value === 'string') answers[key] = value.slice(0, 100);
    }
  }
  sections.ageRating = { answers };

  const choicesUrls: ListingPrivacy['choicesUrls'] = {};
  if (isObject(apple.info)) {
    for (const locale of Object.keys(apple.info).sort().slice(0, 100)) {
      const entry = apple.info[locale];
      const url = isObject(entry) ? entry.privacyChoicesUrl : undefined;
      if (typeof url === 'string' && url !== '') choicesUrls[locale] = url;
    }
  }
  sections.privacy = { choicesUrls };
  return sections;
}
