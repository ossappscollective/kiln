import { redactSecrets, secretStrings } from '../errors.ts';
import type { VerifyOptions, VerifyResult } from '../verify.ts';
import { createRevenueCatClient } from './client.ts';
import { RevenueCatError } from './errors.ts';
import { listRevenueCatApps, listRevenueCatProjects } from './read.ts';

/**
 * "Test connection" for a RevenueCat V2 secret API key: asks which projects the key can see (`GET /v2/projects`) and how many apps
 * each has (`GET /v2/projects/{id}/apps`), both reads, and says so. Never throws; no message or detail carries the key. The stored
 * secret is the key itself (one string, like a GitHub token). It never reads products, customers or metrics.
 */

export type RevenueCatVerifyOptions = VerifyOptions & {
  /** Default https://api.revenuecat.com. */
  apiOrigin?: string | undefined;
  /** Per request. Default 10000. */
  timeoutMs?: number | undefined;
};

const MAX_PROJECTS_SHOWN = 5;

export async function verifyRevenueCatCredential(
  secret: string,
  options: RevenueCatVerifyOptions = {},
): Promise<VerifyResult> {
  const known = secretStrings(secret);
  const clean = (value: string) => redactSecrets(value, known);
  const key = secret.trim();
  if (!key) return { ok: false, message: 'Enter the secret API key.' };
  if (/\s/.test(key)) return { ok: false, message: 'A key has no spaces or line breaks.' };
  // A V2 secret key starts with sk_ (RevenueCat's authentication page). A public SDK key does not, and does not work here.
  const prefixNote = key.startsWith('sk_')
    ? []
    : [
        'The key does not start with sk_. A V2 secret API key does; the public SDK keys do not work for this.',
      ];
  try {
    const client = createRevenueCatClient({
      apiKey: key,
      fetch: options.fetch,
      apiOrigin: options.apiOrigin,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    const { projects } = await listRevenueCatProjects(client);
    if (projects.length === 0) {
      return {
        ok: false,
        message:
          'RevenueCat accepted the key but it sees no project. Create the secret API key inside the project that has your apps.',
        ...(prefixNote.length ? { details: prefixNote } : {}),
      };
    }
    const details: string[] = [];
    for (const project of projects.slice(0, MAX_PROJECTS_SHOWN)) {
      try {
        const { apps } = await listRevenueCatApps(client, project.id);
        const mapped = apps.filter((a) => a.store !== null).length;
        const ignored = apps.length - mapped;
        details.push(
          `Project: ${clean(project.name)} (${apps.length} app${apps.length === 1 ? '' : 's'}${
            ignored > 0 ? `, ${ignored} of a store this tool does not read` : ''
          })`,
        );
      } catch (error) {
        if (error instanceof RevenueCatError && error.kind === 'forbidden') {
          return {
            ok: false,
            message:
              'RevenueCat accepted the key, but it may not read the apps of the project. Allow reading apps for the key in the RevenueCat dashboard.',
            details: [`Project: ${clean(project.name)}`, ...prefixNote],
          };
        }
        throw error;
      }
    }
    if (projects.length > MAX_PROJECTS_SHOWN)
      details.push(`and ${projects.length - MAX_PROJECTS_SHOWN} more projects`);
    const first = projects[0];
    return {
      ok: true,
      message: `Connected to RevenueCat${first && projects.length === 1 ? `, project ${clean(first.name)}` : ''}.`,
      details: [...details, ...prefixNote],
    };
  } catch (error) {
    if (error instanceof RevenueCatError) {
      const status = error.status !== undefined ? [`HTTP status: ${error.status}`] : [];
      const details = [...status, ...(error.kind === 'auth' ? prefixNote : [])];
      return { ok: false, message: clean(error.message), ...(details.length ? { details } : {}) };
    }
    return {
      ok: false,
      message: 'The RevenueCat key could not be checked. Try again in a moment.',
    };
  }
}
