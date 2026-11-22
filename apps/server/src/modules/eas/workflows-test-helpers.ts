import type { Database } from '@kiln/db';
import { PROJECT_ID, TOKEN } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { runAnswer } from '../../../../../packages/connectors/src/expo/workflows.fixtures.ts';
import { bootCi } from '../ci/test-helpers.ts';
import { FakeExpo, json } from './test-helpers.ts';

/** A fake Expo with the Workflows REST API next to the GraphQL one, and a booted CI server (fake GitHub) with an Expo credential. Not a test file. */

export { PROJECT_ID, TOKEN as EXPO_TOKEN };

export type RestCall = { url: string; method: string; authorization: string; body: unknown };

const RUN_IDS = Array.from({ length: 9 }, (_, i) => `019d9d17-013a-7e05-89aa-4aa83ff68c3${i}`);

/** Answers the REST calls like Expo documents them, and the GraphQL ones through `FakeExpo`. */
export class FakeExpoWorkflows {
  readonly graphql = new FakeExpo();
  rest: RestCall[] = [];
  /** Workflow files and Git refs that exist; anything else is a 404, like Expo. */
  files = new Set(['build.yml', 'release.yml']);
  refs = new Set(['main', 'release/1.2']);
  /** Inputs the workflow file declares; any other key is a 400. */
  declared = new Set(['platform', 'build_number', 'profile']);
  /** The runs Expo knows, by id: the status and the jobs it would answer. */
  runs = new Map<string, Record<string, unknown>>();
  /** Answers handed out instead of the normal one: a Response, or an Error to throw. */
  next: (Response | Error)[] = [];
  private n = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/graphql')) return this.graphql.fetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    this.rest.push({
      url,
      method: String(init?.method),
      authorization: headers.authorization ?? '',
      body,
    });
    const queued = this.next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    const path = new URL(url).pathname;
    if (path === '/v2/workflows/dispatch' && init?.method === 'POST') return this.dispatch(body);
    const match = /^\/v2\/workflows\/runs\/([0-9a-f-]+)$/.exec(path);
    if (match && init?.method === 'GET') {
      const run = this.runs.get(match[1] as string);
      return run ? json(runAnswer({ ...run, id: match[1] })) : json({ error: 'not found' }, 404);
    }
    return json({ error: 'no such route' }, 404);
  };

  private dispatch(body: {
    appId?: string;
    gitRef?: string;
    fileName?: string;
    inputs?: Record<string, unknown>;
  }): Response {
    if (!body.appId || !body.gitRef || !body.fileName) return json({ error: 'bad body' }, 400);
    if (!this.refs.has(body.gitRef) || !this.files.has(body.fileName))
      return json({ error: 'not found' }, 404);
    for (const key of Object.keys(body.inputs ?? {}))
      if (!this.declared.has(key)) return json({ error: 'bad inputs' }, 400);
    const id = RUN_IDS[this.n++] as string;
    this.runs.set(id, { status: 'new', requestedGitRef: body.gitRef, jobs: [] });
    return json({
      data: { id, url: `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${id}` },
    });
  }

  /** Changes what Expo answers for a run. */
  setRun(id: string, change: Record<string, unknown>) {
    this.runs.set(id, { ...(this.runs.get(id) ?? {}), ...change });
  }
}

export async function bootEasWorkflows(db: Database, ci: Parameters<typeof bootCi>[1] = {}) {
  const expo = new FakeExpoWorkflows();
  const t = await bootCi(db, ci, { eas: { fetch: expo.fetch } });
  const expoCredentialId = await t.addCredential('expo', TOKEN);

  /** An iOS app of this workspace, linked to the repository and (unless said otherwise) to the Expo project. */
  let seeded = 0;
  const seedLinkedApp = async (
    options: {
      link?: boolean;
      repositoryId?: string | null;
      releases?: Parameters<typeof t.seedApp>[1];
    } = {},
  ) => {
    const appId = await t.seedApp('ios', options.releases ?? [], {
      identifier: `com.acme.trail${++seeded}`,
      ...(options.repositoryId !== undefined ? { repositoryId: options.repositoryId } : {}),
    });
    if (options.link !== false) {
      const res = await t.call(t.owner, 'PUT', `/apps/${appId}/expo`, {
        credentialId: expoCredentialId,
        project: PROJECT_ID,
      });
      if (res.status !== 200) throw new Error(`could not link the app: ${res.text}`);
    }
    return appId;
  };

  const dispatch = (appId: string, body: unknown, cookie = t.owner) =>
    t.call(cookie, 'POST', `/apps/${appId}/expo/workflows/dispatches`, body);
  const runPath = (appId: string, runId: string, refresh = false) =>
    `/apps/${appId}/expo/workflows/runs/${runId}${refresh ? '?refresh=true' : ''}`;

  return { ...t, expo, expoCredentialId, seedLinkedApp, dispatch, runPath };
}

export type EasWorkflowsBoot = Awaited<ReturnType<typeof bootEasWorkflows>>;
