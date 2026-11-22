import { randomBytes } from 'node:crypto';
import type { Database } from '@kiln/db';
import {
  ACCOUNT,
  graphqlError,
  PROJECT_ID,
  project,
  robotViewer,
  TOKEN,
} from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { bootRepoApp, FakeRepo } from '../../repo-test-helpers.ts';

/** A fake Expo and a booted server with an Expo credential and an app. Not a test file. */

export { ACCOUNT, PROJECT_ID, TOKEN as EXPO_TOKEN };

export const OTHER_PROJECT_ID = '9d2b6f40-1c8e-4a37-b5d9-3e7a0c61f284';

export type ExpoCall = {
  url: string;
  authorization: string;
  query: string;
  variables: Record<string, unknown>;
};

/** Answers like Expo: the viewer, projects by full name and by id. `next` makes the following calls answer something else. */
export class FakeExpo {
  calls: ExpoCall[] = [];
  /** Projects Expo knows, by id. */
  projects = new Map<string, ReturnType<typeof project>>([[PROJECT_ID, project()]]);
  /** Answers handed out, in order, instead of the normal one: a Response, or an Error to throw. */
  next: (Response | Error)[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({
      url: String(input),
      authorization: headers.authorization ?? '',
      query: body.query,
      variables: body.variables ?? {},
    });
    const queued = this.next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    return json(this.answer(body.query, body.variables ?? {}));
  };

  private answer(query: string, variables: Record<string, unknown>): unknown {
    if (query.includes('meActor')) return robotViewer();
    if (query.includes('byId')) {
      const found = this.projects.get(String(variables.appId));
      return found
        ? { data: { app: { byId: found } } }
        : graphqlError(`Experience with id ${String(variables.appId)} does not exist`);
    }
    if (query.includes('byFullName')) {
      const found = [...this.projects.values()].find((p) => p.fullName === variables.fullName);
      return found
        ? { data: { app: { byFullName: found } } }
        : graphqlError(`Experience with full name ${String(variables.fullName)} does not exist`);
    }
    return graphqlError('Unexpected server error');
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export async function bootEas(db: Database, overrides: Parameters<typeof bootRepoApp>[2] = {}) {
  const expo = new FakeExpo();
  const repo = new FakeRepo();
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, repo, { masterKey, eas: { fetch: expo.fetch }, ...overrides });
  const expoCredentialId = await t.addCredential('expo', TOKEN);
  const { repositoryId } = await t.connect();

  /** An app record of this workspace, linked to the repository unless said otherwise. */
  const seedApp = async (
    options: {
      id?: string;
      platform?: 'ios' | 'android';
      repositoryId?: string | null;
      workspaceId?: string;
    } = {},
  ) => {
    const id = options.id ?? `app-${Math.random().toString(16).slice(2, 8)}`;
    const platform = options.platform ?? 'ios';
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', ?, 1)`,
      [
        id,
        options.workspaceId ?? t.workspaceId,
        `Acme ${platform}`,
        platform,
        `com.acme.${id}`,
        options.repositoryId === undefined ? repositoryId : options.repositoryId,
      ],
    );
    return id;
  };

  const put = (appId: string, body: unknown, cookie = t.owner) =>
    t.call(cookie, 'PUT', `/apps/${appId}/expo`, body);

  return { ...t, masterKey, expo, repo, expoCredentialId, repositoryId, seedApp, put };
}

export type EasBoot = Awaited<ReturnType<typeof bootEas>>;
