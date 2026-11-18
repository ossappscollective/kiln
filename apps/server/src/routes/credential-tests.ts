import { type Action, can, checkSecret, credentialKinds } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Services, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import {
  type CredentialTesterOptions,
  type TestLimiter,
  type TestOutcome,
  createCredentialTester,
  createTestLimiter,
} from '../services/credential-tests.ts';
import {
  credentialExists,
  loadCredentialForTest,
  recordCredentialTest,
  recordUnsavedCredentialTest,
} from '../services/credentials.ts';
import { type TranslationContext, testLibreTranslateSecret } from '../services/translation.ts';

export type CredentialTestDeps = CredentialTesterOptions & {
  /**
   * The LibreTranslate key is tested against the address saved in the workspace settings, through the
   * same SSRF rules as translation (MRM_TRANSLATE_ALLOW_PRIVATE_URLS); these are the seams for it.
   */
  translate?: Pick<TranslationContext, 'allowPrivateUrls' | 'resolve' | 'exchange'>;
  /** Defaults to 10 tests per workspace per minute, on the app's clock. */
  limiter?: TestLimiter;
};

const testBody = z.object({
  kind: z.enum(credentialKinds),
  secret: z.string().min(1).max(64 * 1024),
});

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

/**
 * Mounted at /api/workspaces, before the other workspace routes, so `/credentials/test` can never
 * be read as a credential id.
 */
export function credentialTestRoutes(services: Services, deps: CredentialTestDeps = {}) {
  const { db, masterKey, now } = services;
  const { translate, limiter: _limiter, ...testerOptions } = deps;
  const baseTest = createCredentialTester({ now, ...testerOptions });
  const test = (workspaceId: string, kind: string, secret: string): Promise<TestOutcome> =>
    kind === 'translate_libretranslate'
      ? testLibreTranslateSecret({ db, masterKey, now, ...(translate ?? {}) }, workspaceId, secret)
      : baseTest(kind, secret);
  const limiter = deps.limiter ?? createTestLimiter({ now });
  const app = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
  const answer = (c: Context<AppEnv>, outcome: TestOutcome) => c.json(outcome);
  const tooMany = (c: Context<AppEnv>, wait: number) => {
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many connection tests. Try again in ${wait} seconds.`,
      },
      429,
    );
  };

  // A secret that has not been saved yet. Nothing is stored; only the fact of the test is audited.
  app.post('/:workspaceId/credentials/test', needs('credentials.write'), async (c) => {
    const body = await parseBody(c, testBody);
    if (!body.ok) return body.response;
    const problem = checkSecret(body.data.kind, body.data.secret);
    if (problem) return c.json({ error: 'invalid_secret', message: problem }, 400);
    const wait = limiter.take(ws(c));
    if (wait > 0) return tooMany(c, wait);
    const outcome = await test(ws(c), body.data.kind, body.data.secret);
    await recordUnsavedCredentialTest(
      db,
      { workspaceId: ws(c), kind: body.data.kind, ok: outcome.ok },
      actor(c),
      now(),
    );
    return answer(c, outcome);
  });

  // A saved credential: decrypted for this one call, and the result remembered on it.
  app.post('/:workspaceId/credentials/:id/test', needs('credentials.write'), async (c) => {
    const id = param(c, 'id');
    // An unknown id is a 404 and costs no slot; a known one is counted before any decrypting or
    // network call.
    if (!(await credentialExists(db, { workspaceId: ws(c), id }))) {
      return c.json({ error: 'not_found' }, 404);
    }
    const wait = limiter.take(ws(c));
    if (wait > 0) return tooMany(c, wait);
    const loaded = await loadCredentialForTest(
      db,
      masterKey,
      { workspaceId: ws(c), id },
      actor(c),
      now(),
    );
    if (!loaded.found) return c.json({ error: 'not_found' }, 404);
    const outcome: TestOutcome =
      loaded.secret === undefined
        ? {
            ok: false,
            message: 'The stored secret could not be decrypted. Enter it again to replace it.',
          }
        : await test(ws(c), loaded.kind, loaded.secret);
    const recorded = await recordCredentialTest(
      db,
      { workspaceId: ws(c), id, ok: outcome.ok, message: outcome.message, version: loaded.version },
      actor(c),
      now(),
    );
    // The secret was replaced (or the credential deleted) while the test ran: the answer is about
    // the old secret, so it is shown once but not remembered.
    return recorded ? answer(c, outcome) : c.json({ ...outcome, superseded: true });
  });

  return app;
}
