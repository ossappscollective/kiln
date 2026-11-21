import {
  type EasConfig,
  type EasConfigRead,
  type EasFinding,
  type ExpoAppSummary,
  GithubError,
  GithubRateLimitError,
  readEasConfig,
} from '@kiln/connectors';
import { type ActorType, byFamily, isDesktop, type Platform } from '@kiln/core';
import type { ManagedApp } from '../../services/apps.ts';
import { isCloneBacked } from '../../services/clone-reads.ts';
import { openRepoSnapshot } from '../../services/repo-snapshot.ts';
import {
  getRepository,
  githubFailure,
  type Outcome,
  openConnectorForRepository,
  type RepoContext,
  withTimeout,
} from '../../services/repositories.ts';

/**
 * `eas.json` of an app, read from its linked repository and shown (docs/api/eas-config.md). Read-only: one read of the repository
 * (audited as `credential.use`, purpose `eas.config`), no call to Expo, no Expo credential. The tree and the files come from the
 * shared snapshot of the repository at one commit (services/repo-snapshot.ts), the same one the scan and the listing read, so a
 * second look at the same commit costs no request. Nothing is stored.
 */

type Actor = { type: ActorType; id: string };

/** The purpose of the credential use (audited), and a read purpose that may be served from a clone. */
export const EAS_CONFIG_PURPOSE = 'eas.config';

export type EasConfigReasonCode = 'no_repository' | 'no_eas_json' | 'unreadable';

export type EasConfigView = {
  app: { id: string; name: string; platform: Platform; identifier: string };
  repository: { id: string; owner: string; repo: string; localOnly: boolean } | null;
  /** The branch that was read: the repository's default branch. */
  branch: string | null;
  /** The commit it was read at; null when the connector could not name it (the branch was read as it was). */
  commit: string | null;
  /** When it was read, epoch milliseconds. */
  readAt: number;
  found: boolean;
  /** Why there is no model: the app has no repository, the repository has no `eas.json` at its root, or it cannot be read as text. */
  reason: { code: EasConfigReasonCode; message: string } | null;
  /** `eas.json` files in subfolders, which are not read. */
  nested: string[];
  path: string | null;
  config: EasConfig | null;
  /** The fields of the JSON app config that relate to `eas.json` (also when there is no `eas.json`). */
  expoApp: ExpoAppSummary | null;
  findings: EasFinding[];
};

const SHA = /^[0-9a-f]{40}$/i;

/** A file the host refused to hand over as text (too large, binary): the answer is "cannot be read", not a failure. */
const isUnreadable = (error: unknown): error is GithubError =>
  error instanceof GithubError &&
  !(error instanceof GithubRateLimitError) &&
  (error.kind === 'not_text' || error.kind === 'too_large');

/** Findings that need what the tool knows about the app: the app's own identifier against the app config. */
function appFindings(app: ManagedApp, expo: ExpoAppSummary): EasFinding[] {
  if (isDesktop(app.platform) || expo.unreadable) return [];
  const expected = byFamily(app.platform, {
    apple: expo.iosBundleIdentifier,
    google: expo.androidPackage,
  });
  if (!expected || !app.identifier || expected === app.identifier) return [];
  const file = expo.path ?? 'the app config';
  return [
    {
      code: 'app_identifier_mismatch',
      severity: 'warning',
      scope: 'app',
      message: `${file} names ${expected} for this platform, but the app here is ${app.identifier}. The repository may belong to another app.`,
    },
  ];
}

const view = (
  app: ManagedApp,
  repository: EasConfigView['repository'],
  at: number,
  rest: Partial<EasConfigView>,
): EasConfigView => ({
  app: { id: app.id, name: app.name, platform: app.platform, identifier: app.identifier },
  repository,
  branch: null,
  commit: null,
  readAt: at,
  found: false,
  reason: null,
  nested: [],
  path: null,
  config: null,
  expoApp: null,
  findings: [],
  ...rest,
});

/**
 * Reads `eas.json` (and `app.json` / `app.config.json`) at the root of the app's repository, at its default branch. An app without a
 * repository, a repository without `eas.json` and a file that cannot be read as text are answers (`found: false` with a reason), not
 * errors; a refused credential, a rate limit or a timeout are failures like in the other repository reads.
 */
export async function readAppEasConfig(
  ctx: RepoContext,
  input: { workspaceId: string; app: ManagedApp },
  actor: Actor,
): Promise<Outcome<{ view: EasConfigView }>> {
  const { workspaceId, app } = input;
  const at = ctx.now();
  const empty = (reason: EasConfigView['reason']) => ({
    ok: true as const,
    view: view(app, null, at, { reason }),
  });
  if (!app.repositoryId) {
    return empty({
      code: 'no_repository',
      message: 'This app is not linked to a repository. Link one to read its eas.json.',
    });
  }
  const repository = await getRepository(ctx.db, workspaceId, app.repositoryId);
  if (!repository) {
    return empty({
      code: 'no_repository',
      message: 'The repository of this app is not connected any more.',
    });
  }
  const repo = {
    id: repository.id,
    owner: repository.owner,
    repo: repository.repo,
    localOnly: repository.localOnly,
  };
  const opened = await openConnectorForRepository(
    ctx,
    workspaceId,
    repository,
    actor,
    EAS_CONFIG_PURPOSE,
  );
  if (!opened.ok) return opened;
  const controller = new AbortController();
  if (isCloneBacked(opened.connector)) opened.connector.useSignal(controller.signal);
  try {
    const { read, ref } = await withTimeout(
      (async () => {
        const snapshot = await openRepoSnapshot({
          repositoryId: repository.id,
          connector: opened.connector,
          branch: repository.defaultBranch,
          now: ctx.now,
          signal: controller.signal,
        });
        const result: EasConfigRead = await readEasConfig(snapshot.files, snapshot.read);
        return { read: result, ref: snapshot.ref };
      })(),
      ctx.timeoutMs,
      () => controller.abort(),
    );
    const where = {
      branch: repository.defaultBranch,
      commit: SHA.test(ref) ? ref : null,
    };
    if (!read.found) {
      return {
        ok: true,
        view: view(app, repo, at, {
          ...where,
          reason: { code: 'no_eas_json', message: read.message },
          nested: read.nested,
          expoApp: read.app,
          findings: appFindings(app, read.app),
        }),
      };
    }
    return {
      ok: true,
      view: view(app, repo, at, {
        ...where,
        found: true,
        path: read.path,
        config: read.config,
        expoApp: read.app,
        findings: [...read.findings, ...appFindings(app, read.app)],
      }),
    };
  } catch (error) {
    if (isUnreadable(error)) {
      return {
        ok: true,
        view: view(app, repo, at, {
          branch: repository.defaultBranch,
          reason: {
            code: 'unreadable',
            message: 'eas.json is too large or is not text, so it was not read.',
          },
        }),
      };
    }
    return githubFailure(error, opened.secret);
  }
}
