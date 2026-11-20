/**
 * Reading a database row without casts. A row comes back as `Record<string, unknown>` (the two dialects
 * differ in what a column holds: a Postgres bigint may arrive as a string), so every column is read through
 * one of these, which says what the code expects and fails loudly when a value is not one of the allowed ones.
 * Services use these instead of writing `String(r.x)`, `Number(r.x)` or `r.x as Platform` themselves.
 */

/** A column that may be NULL, as text (`null` for NULL or a missing column). */
export const nullableString = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/** A column that may be NULL, as a number (epoch milliseconds, counts). */
export const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** A column that may be NULL, converted by `convert` when it is set. */
export const mapOrNull = <T>(v: unknown, convert: (value: unknown) => T): T | null =>
  v === null || v === undefined ? null : convert(v);

/**
 * A column that holds one of a closed list of values (a platform, a status). The result has the union type,
 * so no `as` is needed at the call site; a value that is not in the list throws, naming the column, instead of
 * flowing on as a wrong type.
 */
export function oneOf<const T extends string>(
  v: unknown,
  allowed: readonly T[],
  column: string,
): T {
  for (const value of allowed) if (value === v) return value;
  throw new Error(
    `Column ${column} holds ${JSON.stringify(v)}, expected one of ${allowed.join(', ')}.`,
  );
}

/** Like `oneOf`, but NULL gives `null`. */
export function oneOfOrNull<const T extends string>(
  v: unknown,
  allowed: readonly T[],
  column: string,
): T | null {
  return v === null || v === undefined ? null : oneOf(v, allowed, column);
}
