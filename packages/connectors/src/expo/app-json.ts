/**
 * The Expo project a repository says it belongs to, read from the TEXT of `app.json` only. Code is never run: a dynamic config
 * (`app.config.js`, `app.config.ts`) is not read at all, and the caller says so. Pure.
 *
 * What is read (https://docs.expo.dev/versions/latest/config/app/ and https://docs.expo.dev/eas/json/ name these keys):
 * - `expo.extra.eas.projectId`: the EAS project id (a UUID) that `eas init` writes.
 * - `expo.owner` and `expo.slug`: the account and the project name, which together are `@owner/slug`.
 * A plain config object without the `expo` wrapper (app.json allows it) is read the same way.
 */

export type AppJsonExpoProject = {
  /** A well-formed project id, or null when app.json has none (or it is not a UUID). */
  projectId: string | null;
  owner: string | null;
  slug: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** `undefined` when the text is not JSON or holds no Expo config object. */
export function readExpoProjectFromAppJson(content: string): AppJsonExpoProject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const config = isRecord(parsed.expo) ? parsed.expo : parsed;
  const extra = isRecord(config.extra) ? config.extra : {};
  const eas = isRecord(extra.eas) ? extra.eas : {};
  const id = nonEmpty(eas.projectId);
  return {
    projectId: id !== null && UUID.test(id) ? id.toLowerCase() : null,
    owner: nonEmpty(config.owner),
    slug: nonEmpty(config.slug),
  };
}
