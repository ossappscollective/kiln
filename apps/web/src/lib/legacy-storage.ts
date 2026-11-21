/**
 * Browser storage keys were renamed from `mrm.*` to `kiln.*` with the product (docs/adr/0040-rename-to-kiln.md).
 * `readMigrated` keeps what people already chose: when the new key is absent and the old one is there, the
 * value is copied to the new key once. The old key is left in place (nothing is deleted here).
 */

const KEY_PREFIX = 'kiln.';
const LEGACY_KEY_PREFIX = 'mrm.';

/** The part of `Storage` that is needed: copying needs `setItem`, a read-only view just skips the copy. */
export type MigratingStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>;

/** The name a `kiln.*` key had before the rename, or null for any other key. */
export const legacyKeyOf = (key: string): string | null =>
  key.startsWith(KEY_PREFIX) ? LEGACY_KEY_PREFIX + key.slice(KEY_PREFIX.length) : null;

/** The value stored under `key`, taken from the pre-rename key (and copied across) when `key` itself is unset. May throw like `Storage` does. */
export function readMigrated(storage: MigratingStorage, key: string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const legacy = legacyKeyOf(key);
  if (legacy === null) return null;
  const old = storage.getItem(legacy);
  if (old === null) return null;
  try {
    storage.setItem?.(key, old);
  } catch {
    // Storage refuses writes: the old value is still returned for this visit.
  }
  return old;
}
