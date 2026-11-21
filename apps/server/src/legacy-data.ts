import { existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Default local names after the rename to Kiln, with the fallback to the working-title names
 * (docs/adr/0040-rename-to-kiln.md). The rule is the same everywhere: when the old name exists and
 * the new one does not, keep using the old one. Nothing is moved, copied or deleted.
 */

export type PathExists = (path: string) => boolean;

export const DATA_DIR_DEFAULT = './.kiln-data';
export const DATA_DIR_LEGACY = './.mrm-data';
export const SQLITE_FILE = 'kiln.db';
export const SQLITE_FILE_LEGACY = 'mrm.db';

/** The data folder when no data folder is configured: `./.kiln-data`, or `./.mrm-data` when only that exists. */
export function defaultDataDir(exists: PathExists = existsSync): string {
  return !exists(DATA_DIR_DEFAULT) && exists(DATA_DIR_LEGACY) ? DATA_DIR_LEGACY : DATA_DIR_DEFAULT;
}

/**
 * A SQLite `file:` URL that names `kiln.db` keeps naming the earlier `mrm.db` next to it when only that
 * file exists. Any other URL (Postgres, another file name, a query string) is returned as it is.
 */
export function sqliteUrlInUse(url: string, exists: PathExists = existsSync): string {
  if (!url.startsWith('file:') || url.includes('?')) return url;
  const path = url.slice('file:'.length);
  if (basename(path) !== SQLITE_FILE || exists(path)) return url;
  const earlier = path.slice(0, path.length - SQLITE_FILE.length) + SQLITE_FILE_LEGACY;
  return exists(earlier) ? `file:${earlier}` : url;
}
