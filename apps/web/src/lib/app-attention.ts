import type { Platform, StagedChangesView } from '@kiln/core';
import { appAddress, type PlatformScope } from './app-scope.ts';
import { type AsoMover, type AsoSummary, asoViewHref, isBigDrop, moverText } from './aso/aso.ts';
import { t } from './i18n/t.ts';
import type { IconName } from './icons.ts';
import { platformLabel } from './portfolio.ts';
import { type SummaryStall, unfinishedItem } from './release-pipeline.ts';
import type { AppBuild, PlanSummary } from './types.ts';

/**
 * "Needs attention" on the dashboard of an app, as pure functions: what a person should look at, built
 * from data the app screens already read (reviews, builds, listing drift, staged changes, plans, the
 * last sync). Nothing is fetched here, and a kind of item with nothing to show produces no item.
 */

export type AttentionTone = 'bad' | 'warn' | 'info';

export type AttentionItem = {
  id: string;
  tone: AttentionTone;
  icon: IconName;
  text: string;
  /** A second, muted line; null when there is nothing to add. */
  detail: string | null;
  /** Where to look; null when the item is already on this screen. */
  href: string | null;
  /** The name of the link, for the item's text. */
  action: string;
  /** Set on "Draft pushed — ready to submit?": the list draws the submit control of this app instead of a link. */
  submitAppId?: string;
};

export type AttentionApp = { id: string; platform: Platform; lastSyncError: string | null };

export type AttentionInput = {
  apps: readonly AttentionApp[];
  scope: PlatformScope | null;
  /** New (untriaged) reviews by app id; an app that is missing here has no data. */
  newReviews: Readonly<Record<string, number | undefined>>;
  /** Builds by app id. */
  builds: Readonly<Record<string, readonly AppBuild[] | undefined>>;
  /** Locales that differ from the store or the repository, by app id. */
  driftLocales: Readonly<Record<string, number | undefined>>;
  /** Staged changes that were not pushed to the store draft, by app id. */
  stagedUnpushed: Readonly<Record<string, number | undefined>>;
  /** Plans by app id. */
  plans: Readonly<Record<string, readonly PlanSummary[] | undefined>>;
  /** Apps whose pushed draft waits to be submitted for review (only filled for admin and up). Optional. */
  submitReady?: Readonly<Record<string, boolean | undefined>>;
  /** The ASO summary by app id (one call each, our own database). Optional: an app without one has nothing to say. */
  aso?: Readonly<Record<string, AsoSummary | undefined>>;
  /** The release pipeline's stall by app id (a release left unfinished), from the pipeline summary. Optional. */
  unfinished?: Readonly<Record<string, SummaryStall | null | undefined>>;
};

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** The newest build, by upload time and then by when it was synced. */
export function newestBuild(builds: readonly AppBuild[]): AppBuild | null {
  let best: AppBuild | null = null;
  for (const b of builds) {
    if (best === null || (b.uploadedAt ?? b.syncedAt) > (best.uploadedAt ?? best.syncedAt))
      best = b;
  }
  return best;
}

/** True when the CI run of a build finished badly (failed, timed out, did not start). */
export const ciFailed = (build: Pick<AppBuild, 'link'>): boolean => {
  const run = build.link?.run ?? null;
  return (
    run !== null &&
    run.status === 'completed' &&
    run.conclusion !== null &&
    FAILED.has(run.conclusion)
  );
};

/** The staged items (texts and asset sets) that are not in the store draft yet, and not the same as the store. */
export function stagedUnpushedCount(
  view:
    | (Pick<StagedChangesView, 'text' | 'assets'> & {
        release?: readonly { pushed: boolean; localOnly: boolean }[];
      })
    | null,
): number {
  if (view === null) return 0;
  return (
    view.text.filter((t) => !t.pushed && t.status !== 'unchanged').length +
    view.assets.filter((a) => !a.pushed).length +
    (view.release ?? []).filter((r) => !r.pushed && !r.localOnly).length
  );
}

const rank: Record<AttentionTone, number> = { bad: 0, warn: 1, info: 2 };

export function attentionItems(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const several = input.apps.length > 1;

  for (const app of input.apps) {
    const say = (text: string): string =>
      several ? t('app:attention.withPlatform', { platform: platformLabel(app.platform), text }) : text;
    const link = (section: Parameters<typeof appAddress>[1]) =>
      appAddress(app.id, section, input.scope);

    if ((app.lastSyncError ?? '').trim() !== '') {
      out.push({
        id: `${app.id}:sync`,
        tone: 'bad',
        icon: 'alert-triangle',
        text: say(t('app:attention.syncFailed')),
        detail: (app.lastSyncError ?? '').trim(),
        href: null,
        action: t('app:attention.syncAction'),
      });
    }

    const left = unfinishedItem({
      appId: app.id,
      platform: app.platform,
      scope: input.scope,
      several,
      stalled: input.unfinished?.[app.id] ?? null,
    });
    if (left !== null) out.push(left);

    const newest = newestBuild(input.builds[app.id] ?? []);
    if (newest !== null && ciFailed(newest)) {
      out.push({
        id: `${app.id}:ci`,
        tone: 'bad',
        icon: 'x-circle',
        text: say(t('app:attention.ciFailed', { build: newest.buildNumber })),
        detail: t('app:attention.ciDetail', { version: newest.version }),
        href: link('builds'),
        action: t('app:attention.ciAction'),
      });
    }

    for (const plan of input.plans[app.id] ?? []) {
      if (plan.released) continue;
      if (plan.platform !== null && plan.platform !== app.platform) continue;
      const href = appAddress(app.id, 'releases', input.scope, plan.version);
      if (plan.blocked) {
        out.push({
          id: `${app.id}:plan:${plan.id}:blocked`,
          tone: 'bad',
          icon: 'lock',
          text: say(t('app:attention.blocked', { version: plan.version })),
          detail: plan.blockedReason,
          href,
          action: t('app:attention.planAction'),
        });
      } else if (plan.due.overdue) {
        out.push({
          id: `${app.id}:plan:${plan.id}:overdue`,
          tone: 'bad',
          icon: 'clock',
          text: say(t('app:attention.overdue', { version: plan.version })),
          detail: plan.targetDate ? t('app:attention.overdueDetail', { date: plan.targetDate }) : null,
          href,
          action: t('app:attention.planAction'),
        });
      } else if (plan.due.dueSoon) {
        out.push({
          id: `${app.id}:plan:${plan.id}:soon`,
          tone: 'warn',
          icon: 'clock',
          text: say(t('app:attention.dueSoon', { version: plan.version })),
          detail: plan.targetDate ? t('app:attention.dueSoonDetail', { date: plan.targetDate }) : null,
          href,
          action: t('app:attention.planAction'),
        });
      }
    }

    const drift = input.driftLocales[app.id] ?? 0;
    if (drift > 0) {
      out.push({
        id: `${app.id}:drift`,
        tone: 'warn',
        icon: 'file-text',
        text: say(t('app:attention.drift', { count: drift })),
        detail: null,
        href: link('listing'),
        action: t('app:attention.listingAction'),
      });
    }

    const staged = input.stagedUnpushed[app.id] ?? 0;
    if (staged > 0) {
      out.push({
        id: `${app.id}:staged`,
        tone: 'warn',
        icon: 'layers',
        text: say(t('app:attention.staged', { count: staged })),
        detail: null,
        href: link('listing'),
        action: t('app:attention.stagedAction'),
      });
    }

    if (input.submitReady?.[app.id] === true) {
      out.push({
        id: `${app.id}:submit`,
        tone: 'info',
        icon: 'upload',
        text: say(t('app:attention.submitReady')),
        detail: null,
        href: null,
        action: t('app:attention.submitAction'),
        submitAppId: app.id,
      });
    }

    const aso = input.aso?.[app.id];
    if (aso) {
      const drops = aso.movers.filter((m) => isBigDrop(m));
      if (drops.length > 0) {
        const first = drops[0] as AsoMover;
        out.push({
          id: `${app.id}:aso-drops`,
          tone: 'warn',
          icon: 'arrow-down',
          text: say(t('app:attention.asoDrops', { count: drops.length })),
          detail:
            drops.length > 1
              ? t('app:attention.asoDropMore', { term: first.term, move: moverText(first), count: drops.length - 1 })
              : t('app:attention.asoDropDetail', { term: first.term, move: moverText(first) }),
          href: asoViewHref(app.id, 'keywords', input.scope),
          action: t('app:attention.asoAction'),
        });
      }
      if (aso.competitors.changedRecently > 0) {
        out.push({
          id: `${app.id}:aso-competitors`,
          tone: 'info',
          icon: 'activity',
          text: say(t('app:attention.competitors', { count: aso.competitors.changedRecently })),
          detail: null,
          href: asoViewHref(app.id, 'competitors', input.scope),
          action: t('app:attention.competitorsAction'),
        });
      }
    }

    const fresh = input.newReviews[app.id] ?? 0;
    if (fresh > 0) {
      out.push({
        id: `${app.id}:reviews`,
        tone: 'info',
        icon: 'message',
        text: say(t('app:attention.newReviews', { count: fresh })),
        detail: null,
        href: link('reviews'),
        action: t('app:attention.reviewsAction'),
      });
    }
  }

  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank[a.item.tone] - rank[b.item.tone] || a.index - b.index)
    .map((x) => x.item);
}
