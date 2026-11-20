import type { ServerModule } from '../module.ts';
import { type PendingRoutesContext, pendingRoutes } from './pending-routes.ts';
import { type ReleaseRoutesContext, storeReleaseRoutes } from './release-routes.ts';
import { type RolloutRoutesContext, rolloutRoutes } from './rollout-routes.ts';
import { type StagedRoutesContext, stagedRoutes } from './staged-routes.ts';
import { type SubmitRoutesContext, storeSubmitRoutes } from './submit-routes.ts';
import { storeVersionRoutes, type VersionRoutesContext } from './version-routes.ts';

/**
 * Writing to the stores (docs/api/staged-changes.md, submit.md, releases-write.md, rollout.md, store-version.md, pending.md):
 * staged listing text and graphics, the draft push, the version, submitting for review, releasing, the rollout and
 * publishing everything an app has pending. Every store write here is OFF unless its own switch is on, and each step keeps
 * its own switch, right, seams and gates. The seams below are what tests replace; production sets only the switches.
 */
export type PublishDeps = {
  /**
   * Changing a live rollout (MRM_STORE_ROLLOUT_ENABLED). `connectorFactory` builds the connector that can read and change a
   * rollout (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  rollout?: RolloutRoutesContext['rollout'] | undefined;
  /**
   * Staged listing text and graphics, and writing them to the store as a DRAFT: a store write that is OFF unless `enabled`
   * (MRM_STORE_DRAFT_WRITE_ENABLED). `connectorFactory` builds the connector that can read and write a draft (fakes in
   * tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  draft?: StagedRoutesContext['draft'] | undefined;
  /**
   * Submitting the draft for review (docs/adr/0010-store-submit.md): OFF unless `enabled` (MRM_STORE_SUBMIT_ENABLED).
   * `connectorFactory` builds the connector that can read and submit (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  submit?: SubmitRoutesContext['submit'] | undefined;
  /**
   * Releasing (docs/adr/0014-release-management.md): OFF unless `enabled` (MRM_STORE_RELEASE_ENABLED). The reads of builds and
   * version codes use the draft connector (`draft.connectorFactory`) and no switch.
   */
  release?: ReleaseRoutesContext['release'] | undefined;
  /**
   * Creating the next App Store version: a reversible write behind the SAME switch as the draft push (`draft.enabled`) and its
   * timeouts. Only `connectorFactory` (fakes in tests) is set here.
   */
  version?: Pick<NonNullable<VersionRoutesContext['version']>, 'connectorFactory'> | undefined;
  /**
   * Publishing everything an app has pending in one go (docs/adr/0015-pending-and-batch-publish.md): OFF unless `enabled`
   * (MRM_STORE_PUBLISH_BATCH_ENABLED). It turns no step on: the steps keep the switches and seams above. `claimTtlMs` is for tests.
   */
  publish?: PendingRoutesContext['publish'] | undefined;
};

export const publishModule: ServerModule<PublishDeps> = {
  id: 'publish',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    const { rollout, draft, submit, release, version, publish } = deps ?? {};
    app.route('/api/workspaces', rolloutRoutes({ db, masterKey, now, ...(rollout ? { rollout } : {}) }));
    // Staging touches the database only (files are read through the asset index, with the budget of the Assets tab).
    app.route(
      '/api/workspaces',
      stagedRoutes({
        db,
        masterKey,
        now,
        repo: shared.repo,
        limiter: shared.assetsLimiter,
        ...(draft ? { draft } : {}),
      }),
    );
    app.route('/api/workspaces', storeSubmitRoutes({ db, masterKey, now, ...(submit ? { submit } : {}) }));
    app.route(
      '/api/workspaces',
      storeVersionRoutes({
        db,
        masterKey,
        now,
        version: {
          ...(draft?.enabled !== undefined ? { enabled: draft.enabled } : {}),
          ...(draft?.timeoutMs !== undefined ? { timeoutMs: draft.timeoutMs } : {}),
          ...(draft?.claimTtlMs !== undefined ? { claimTtlMs: draft.claimTtlMs } : {}),
          ...(version?.connectorFactory ? { connectorFactory: version.connectorFactory } : {}),
        },
      }),
    );
    app.route(
      '/api/workspaces',
      storeReleaseRoutes({
        db,
        masterKey,
        now,
        ...(draft
          ? {
              draft: {
                ...(draft.connectorFactory ? { connectorFactory: draft.connectorFactory } : {}),
                ...(draft.timeoutMs !== undefined ? { timeoutMs: draft.timeoutMs } : {}),
              },
            }
          : {}),
        ...(release ? { release } : {}),
      }),
    );
    app.route(
      '/api/workspaces',
      pendingRoutes({
        db,
        masterKey,
        now,
        repo: shared.repo,
        ...(publish ? { publish } : {}),
        ...(draft ? { draft } : {}),
        ...(submit ? { submit } : {}),
        ...(release ? { release } : {}),
        ...(rollout ? { rollout } : {}),
      }),
    );
  },
};
