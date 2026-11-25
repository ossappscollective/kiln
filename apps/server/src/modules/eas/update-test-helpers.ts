import type { Database } from '@kiln/db';
import { graphqlError } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import {
  BRANCH_MAIN,
  BRANCH_NEXT,
  build,
  channel,
  GROUP_A,
  GROUP_B,
  group,
  insightsBody,
  rolloutMapping,
} from '../../../../../packages/connectors/src/expo/updates.fixtures.ts';
import { bootEas, EXPO_TOKEN, json, PROJECT_ID } from './test-helpers.ts';

/** A fake Expo for EAS Update and a booted server with a linked app. Not a test file. */

export { BRANCH_MAIN, BRANCH_NEXT, EXPO_TOKEN, GROUP_A, GROUP_B, PROJECT_ID };

type Any = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: fixture bodies are shaped loosely

export type UpdateCall = {
  operationName: string;
  authorization: string;
  variables: Record<string, unknown>;
};

/** The groups of one branch as Expo shapes them: lists of updates, one per platform. */
export const groupOf = (
  id: string,
  rollout?: number,
  runtime = '1.4.0',
  at = '2026-11-18T10:00:00.000Z',
) =>
  group(id, ['ios', 'android'], {
    runtime: { version: runtime },
    createdAt: at,
    rolloutPercentage: rollout ?? null,
  });

/** Production on main at runtime 1.4.0, plus a staging channel with a rollout between two branches and a per-update rollout. */
export const defaultChannels = (): Any[] => [
  channel({
    updateBranches: [{ id: BRANCH_MAIN, name: 'main', updateGroups: [groupOf(GROUP_A)] }],
  }),
  channel({
    id: 'cc000000-0000-4000-8000-000000000002',
    name: 'staging',
    branchMapping: rolloutMapping(),
    updateBranches: [
      {
        id: BRANCH_NEXT,
        name: 'next',
        updateGroups: [groupOf(GROUP_B, 25, '1.5.0', '2026-11-19T10:00:00.000Z')],
      },
      { id: BRANCH_MAIN, name: 'main', updateGroups: [groupOf(GROUP_A)] },
    ],
  }),
];

/** Answers like Expo for the EAS Update operations, remembers every call, and applies a rollout change to its own state. */
export class FakeUpdates {
  calls: UpdateCall[] = [];
  channels: Any[] = defaultChannels();
  builds: Any[] = [
    build(),
    build({
      id: 'dd000000-0000-4000-8000-000000000009',
      platform: 'ANDROID',
      runtime: { version: '1.4.0' },
    }),
  ];
  insights: unknown = insightsBody();
  /** Answers for the next calls, in order, instead of the normal one: a Response, an Error to throw, or a function over the call. */
  next: (Response | Error | ((call: UpdateCall) => Response | Error | undefined))[] = [];
  /** Looks at every call before the queue does: a Response or an Error answers it, undefined lets it through. */
  intercept: ((call: UpdateCall) => Response | Error | undefined) | undefined;
  /** After the mutation is received: what it does to the state. `ignore` leaves the state alone (the write was lost). */
  mutation: 'apply' | 'ignore' = 'apply';

  count = (name: string) => this.calls.filter((c) => c.operationName === name).length;

  readonly fetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: UpdateCall = {
      operationName: body.operationName ?? '',
      authorization: headers.authorization ?? '',
      variables: body.variables ?? {},
    };
    this.calls.push(call);
    let queued: Response | Error | undefined = this.intercept?.(call);
    if (queued === undefined) {
      const first = this.next.shift();
      queued = typeof first === 'function' ? first(call) : first;
    }
    if (queued instanceof Error) {
      // A write that was received and applied, whose answer is lost.
      if (call.operationName === 'KilnSetUpdateRollout') this.answer(call);
      throw queued;
    }
    if (queued) return queued;
    return json(this.answer(call));
  };

  private answer(call: UpdateCall): unknown {
    switch (call.operationName) {
      case 'KilnUpdateChannels':
        return { data: { app: { byId: { id: PROJECT_ID, updateChannels: this.channels } } } };
      case 'KilnStoreBuildRuntimes':
        return { data: { app: { byId: { id: PROJECT_ID, builds: this.builds } } } };
      case 'KilnUpdateGroupInsights':
        return this.insights;
      case 'KilnSetUpdateRollout': {
        const id = String(call.variables.updateId);
        const pct = Number(call.variables.rolloutPercentage);
        for (const ch of this.channels) {
          for (const br of ch.updateBranches as Any[]) {
            for (const g of br.updateGroups as Any[][]) {
              for (const u of g) {
                if (u.id === id && this.mutation === 'apply') u.rolloutPercentage = pct;
              }
            }
          }
        }
        return {
          data: {
            update: { setRolloutPercentage: { id, group: GROUP_B, rolloutPercentage: pct } },
          },
        };
      }
      default:
        return graphqlError('Unexpected server error');
    }
  }

  /** The updates of the staging channel's `next` branch: the first group, one per platform. */
  nextGroup = (): { rolloutPercentage: number | null }[] =>
    this.channels[1]?.updateBranches[0].updateGroups[0] ?? [];

  /** The id of the update of a platform in a group (as the fixtures number them). */
  updateId(groupId: string, platform: 'ios' | 'android' = 'ios'): string {
    for (const ch of this.channels) {
      for (const br of ch.updateBranches as Any[]) {
        for (const g of br.updateGroups as Any[][]) {
          for (const u of g)
            if (u.group === groupId && u.platform === platform) return String(u.id);
        }
      }
    }
    throw new Error(`no update for ${groupId}`);
  }
}

export async function bootUpdates(db: Database, options: { rolloutEnabled?: boolean } = {}) {
  const fake = new FakeUpdates();
  const t = await bootEas(db, {
    eas: { fetch: fake.fetch, updateRollout: { enabled: options.rolloutEnabled === true } },
  });
  /** An app record of this workspace, linked to the project with the Expo credential. */
  const linkedApp = async (platform: 'ios' | 'android' | 'macos' = 'ios', link = true) => {
    const id = `app-${platform}-${Math.random().toString(16).slice(2, 8)}`;
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', NULL, 1)`,
      [id, t.workspaceId, `Acme ${platform}`, platform, `com.acme.${id}`],
    );
    if (link) {
      await db.execute(
        `INSERT INTO app_expo_links
           (app_id, workspace_id, credential_id, project_id, account_name, slug, project_name, verified_at, linked_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'acme', 'trail-notes', 'Trail Notes', 1, 'u', 1, 1)`,
        [id, t.workspaceId, t.expoCredentialId, PROJECT_ID],
      );
    }
    return id;
  };
  const stateOf = (appId: string, cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${appId}/expo/updates`);
  const preview = (appId: string, body: unknown, cookie = t.owner) =>
    t.call(cookie, 'POST', `/apps/${appId}/expo/updates/rollout/preview`, body);
  /** Like `t.call`, with extra request headers (the step-up grant travels in one). */
  const send = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    t.texts.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
  const apply = (
    appId: string,
    body: unknown,
    cookie = t.owner,
    headers: Record<string, string> = {},
  ) => send(cookie, 'POST', `/apps/${appId}/expo/updates/rollout/apply`, body, headers);
  /** A step-up grant (by the owner's password) for raising the rollout of an app, bound to the hash the preview gave. */
  const grantFor = async (appId: string, hash: string) => {
    const res = await send(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'rollout',
      target: { id: appId, hash },
      password: 'correct horse battery staple',
    });
    if (res.status !== 200) throw new Error(`step-up verify answered ${res.status}: ${res.text}`);
    return res.body.grant as string;
  };
  return { ...t, fake, linkedApp, stateOf, preview, apply, send, grantFor };
}

export type UpdatesBoot = Awaited<ReturnType<typeof bootUpdates>>;
