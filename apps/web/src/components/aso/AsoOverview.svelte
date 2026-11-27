<!--
  AsoOverview: the ASO view of the whole workspace (#/aso): the keywords that moved most across all apps, competitor changes,
  and one row per app, with "Where to start" (the first next step of each app, see AsoCoach). It reads one summary and the
  next steps per app from our own database (no store is contacted). With nothing tracked it is
  one line that points to adding keywords. Admins can queue a check of every app and set how many places a keyword has to
  move before `aso.rank_changed` is raised (the Settings screen has no generic field for it, so it lives here).
  Props (from the shell): api, workspaceId, role.
-->
<script lang="ts">
  import { can, type CoachAction, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    type AsoConfig,
    type OverviewRow,
    asoErrorMessage,
    asoViewHref,
    hasAsoData,
    moverMarket,
    moverText,
    overviewMovers,
    overviewStats,
    parseThreshold,
  } from '../../lib/aso/aso.ts';
  import { coachHref } from '../../lib/aso/budget.ts';
  import { coachWords } from '../../lib/core-text.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { appLabel, platformLabel, portfolioHref, runLimited } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';
  import T from '../ui/T.svelte';
  import AsoHealthAi from './AsoHealthAi.svelte';
  import AsoStatus from './AsoStatus.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';
  import { readApps } from '../../lib/app-state/workspace-reads.ts';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'aso.read'));
  const canManage = $derived(can(role, 'aso.manage'));
  const uid = $props.id();

  let apps = $state<AppSummary[] | null>(null);
  let rows = $state<OverviewRow[]>([]);
  let config = $state<AsoConfig | null>(null);
  /** The first steps of each app (core `buildCoach`, by app id); an app whose steps could not be read is left out. */
  let coaches = $state<Record<string, CoachAction[] | undefined>>({});
  let error = $state('');
  let loading = $state(true);
  const clock = useNow({ everyMs: 30_000 });
  const now = $derived(clock.value);
  let generation = 0;

  const withData = $derived(rows.filter((r) => hasAsoData(r.summary)));
  const stats = $derived(overviewStats(rows));
  const movers = $derived(overviewMovers(rows));
  const changed = $derived(withData.filter((r) => r.summary.competitors.changedRecently > 0));
  const hasMoves = $derived(movers.gains.length + movers.drops.length > 0);
  const androidTracked = $derived(withData.some((r) => supports(r.platform, 'searchTermsImport')));
  /** The first next step of each app that has one, in the order of the app list: where to start. */
  const starts = $derived(
    (apps ?? [])
      .map((a) => ({ app: a, step: coaches[a.id]?.[0], total: coaches[a.id]?.length ?? 0 }))
      .filter((r): r is { app: AppSummary; step: CoachAction; total: number } => r.step !== undefined)
      // Apps that already track keywords first; "track your first keywords" can wait.
      .sort((a, b) => Number(a.step.kind === 'track_keywords') - Number(b.step.kind === 'track_keywords'))
      .slice(0, 6),
  );
  const appName = (id: string): string => {
    const a = apps?.find((x) => x.id === id);
    return a ? appLabel(a) : '';
  };

  async function load() {
    const mine = ++generation;
    error = '';
    loading = true;
    try {
      const list = (await readApps(api, workspaceId)).apps;
      if (mine !== generation) return;
      apps = list;
      const next: OverviewRow[] = [];
      const steps: Record<string, CoachAction[] | undefined> = {};
      await runLimited(list, 4, async (a) => {
        try {
          next.push({ name: a.name, appId: a.id, platform: a.platform, summary: await api.asoSummary(workspaceId, a.id) });
        } catch {
          // An app that cannot be read is left out; the rest still shows.
        }
        try {
          steps[a.id] = (await api.asoCoach(workspaceId, a.id)).actions;
        } catch {
          // The next steps are a help, not the screen: without them the rest still shows.
        }
      });
      if (mine !== generation) return;
      coaches = steps;
      rows = list.map((a) => next.find((r) => r.appId === a.id)).filter((r): r is OverviewRow => r !== undefined);
    } catch (e) {
      if (mine !== generation) return;
      error = asoErrorMessage(e, t('aso:overview.loadFailed'));
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    const space = workspaceId;
    untrack(() => {
      apps = null;
      rows = [];
      coaches = {};
      config = null;
      if (!canRead) return;
      void load();
      api
        .asoConfig(space)
        .then((c) => {
          if (space === workspaceId) {
            config = c;
            threshold = String(c.rankMoveThreshold);
          }
        })
        .catch(() => undefined);
    });
  });

  // ----- Check every app (admins): queues jobs, spaced by the server.
  let confirmAll = $state(false);
  let queuing = $state(false);

  async function queueAll() {
    queuing = true;
    try {
      const out = await api.refreshAsoAll(workspaceId);
      const skipped = out.skipped.alreadyQueued + out.skipped.notReady + out.skipped.playOff + out.skipped.capped;
      toast.success(skipped > 0 ? t('aso:overview.queuedSkipped', { count: out.queued, skipped }) : t('aso:overview.queued', { count: out.queued }));
      confirmAll = false;
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:overview.queueFailed')));
    } finally {
      queuing = false;
    }
  }

  // ----- The alert threshold (aso.rankMoveThreshold)
  let threshold = $state('5');
  let saving = $state(false);
  const parsedThreshold = $derived(parseThreshold(threshold));
  const dirty = $derived(config !== null && parsedThreshold !== config.rankMoveThreshold);

  async function saveThreshold(event: SubmitEvent) {
    event.preventDefault();
    if (parsedThreshold === null || saving) return;
    saving = true;
    try {
      await api.updateWorkspaceSettings(workspaceId, { 'aso.rankMoveThreshold': parsedThreshold });
      if (config) config = { ...config, rankMoveThreshold: parsedThreshold };
      toast.success(t('aso:overview.saved'));
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:overview.saveFailed')));
    } finally {
      saving = false;
    }
  }

  const stateNote = (r: OverviewRow): { text: string; tone: 'warn' | 'neutral' } | null => {
    const s = r.summary;
    if (s.state.backoffUntil !== null && s.state.backoffUntil > now) return { text: t('aso:overview.waiting'), tone: 'warn' };
    if (s.state.lastError !== null) return { text: t('aso:overview.lastFailed'), tone: 'warn' };
    if (s.keywords.failing > 0) return { text: t('aso:overview.failingCount', { count: s.keywords.failing }), tone: 'warn' };
    return null;
  };
</script>

<section aria-busy={loading}>
  <PageHeader title="ASO" description={t('aso:overview.description')}>
    {#snippet actions()}
      {#if canManage && withData.length > 0}
        {#if confirmAll}
          <span class="confirm">
            {t('aso:overview.queueQuestion')}
            <Button size="sm" variant="primary" loading={queuing} onclick={queueAll}>{t('aso:overview.queueChecks')}</Button>
            <Button size="sm" variant="ghost" onclick={() => (confirmAll = false)}>{t('common:action.cancel')}</Button>
          </span>
        {:else}
          <Button icon="refresh" onclick={() => (confirmAll = true)}>{t('aso:overview.checkAll')}</Button>
        {/if}
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">{t('aso:overview.noRole')}</Alert>
  {:else if error}
    <Alert tone="error" title={t('aso:overview.loadFailedTitle')}>{error}</Alert>
    <p><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></p>
  {:else if loading && apps === null}
    <div role="status" aria-label={t('aso:overview.loading')} class="stack">
      <Skeleton width="100%" height="32px" />
      <Skeleton width="100%" height="160px" />
    </div>
  {:else if withData.length === 0}
    <div class="empty card">
      <p>
        {t('aso:overview.empty')}
        {#if apps && apps.length > 0}{t('aso:overview.emptyOpen')}{:else}<T key="aso:overview.emptyAddApp" tags={{ link: addApp }} />{/if}
      </p>
      {#if apps && apps.length > 0}
        <p class="applinks">
          {#each apps.slice(0, 8) as a (a.id)}
            <Button size="sm" href={asoViewHref(a.id, 'keywords', a.platform)}>{appLabel(a)}</Button>
          {/each}
        </p>
      {/if}
    </div>
  {:else}
    <div class="stack">
      <div class="row top">
        <span class="chips">
          <StatChip label={t('aso:overview.chip.apps', { count: stats.apps })} value={stats.apps} />
          <StatChip label={t('aso:overview.chip.keywords', { count: stats.keywords })} value={stats.keywords} />
          <StatChip label={t('aso:overview.chip.top10')} value={stats.top10} tone="ok" />
          <StatChip label={t('aso:overview.chip.competitors', { count: stats.competitors })} value={stats.competitors} />
          <StatChip label={t('aso:overview.chip.changes')} value={stats.competitorChanges} tone="info" hideZero />
          <StatChip label={t('aso:overview.chip.failing')} value={stats.failing} tone="warn" hideZero />
        </span>
        <span class="spacer"></span>
        <AsoStatus {config} androidInScope={androidTracked} />
      </div>

      {#if starts.length > 0}
        <section class="card" aria-label={t('aso:overview.start')}>
          <h2 class="h"><Icon name="check-circle" size={16} /> {t('aso:overview.start')}</h2>
          <ul class="movers starts">
            {#each starts as r (r.app.id)}
              <li>
                <span class="what">
                  <strong class="truncate">{coachWords(r.step, () => '').title}</strong>
                  <span class="muted">{r.total > 1 ? t('aso:overview.appSteps', { app: appLabel(r.app), count: r.total }) : appLabel(r.app)}</span>
                </span>
                <Button size="sm" href={coachHref(r.step.link, r.app.id, r.app.platform)}>{coachWords(r.step, () => '').linkLabel}</Button>
              </li>
            {/each}
          </ul>
          <p class="muted hint">{t('aso:overview.startHint')}</p>
        </section>
      {/if}

      <AsoHealthAi {api} {workspaceId} {role} targets={(apps ?? []).filter((a) => withData.some((r) => r.appId === a.id))} />

      {#if hasMoves}
        <div class="moves">
          {#each [{ title: k('aso:overview.up'), list: movers.gains, icon: 'trending-up' as const }, { title: k('aso:overview.down'), list: movers.drops, icon: 'arrow-down' as const }] as group (group.title)}
            <section class="card" aria-label={t(group.title)}>
              <h2 class="h"><Icon name={group.icon} size={16} /> {t(group.title)}</h2>
              {#if group.list.length === 0}
                <p class="muted none">{t('aso:overview.nothingYet')}</p>
              {:else}
                <ul class="movers">
                  {#each group.list as m (`${m.appId}:${m.keywordId}`)}
                    <li>
                      <span class="what">
                        <strong class="truncate" title={m.term}>{m.term}</strong>
                        <span class="muted">{moverMarket(m)}</span>
                      </span>
                      <span class="tabular">{moverText(m)}</span>
                      <a class="app" href={asoViewHref(m.appId, 'keywords', m.platform)}>{appName(m.appId) || m.name}</a>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      {/if}

      {#if changed.length > 0}
        <section class="card" aria-label={t('aso:overview.chip.changes')}>
          <h2 class="h"><Icon name="activity" size={16} /> {t('aso:overview.changedTitle')}</h2>
          <ul class="movers">
            {#each changed as r (r.appId)}
              <li>
                <span class="what"><strong>{appName(r.appId) || r.name}</strong></span>
                <span class="tabular">{t('aso:overview.changedOf', { count: r.summary.competitors.changedRecently, total: r.summary.competitors.total })}</span>
                <a class="app" href={asoViewHref(r.appId, 'competitors', r.platform)}>{t('aso:overview.open')}</a>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <div class="table-wrap">
        <table class="compact">
          <thead>
            <tr>
              <th scope="col">{t('aso:overview.col.app')}</th>
              <th scope="col" class="num">{t('aso:overview.col.keywords')}</th>
              <th scope="col" class="num">{t('aso:overview.col.ranked')}</th>
              <th scope="col" class="num">{t('aso:overview.col.top10')}</th>
              <th scope="col" class="num">{t('aso:overview.col.competitors')}</th>
              <th scope="col">{t('aso:overview.col.lastCheck')}</th>
              <th scope="col"><span class="visually-hidden">{t('aso:overview.col.state')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each withData as r (r.appId)}
              {@const note = stateNote(r)}
              <tr>
                <th scope="row" class="name">
                  <a href={asoViewHref(r.appId, 'keywords', r.platform)}>{r.name}</a>
                  <Badge>{platformLabel(r.platform)}</Badge>
                </th>
                <td class="num">{r.summary.keywords.total}</td>
                <td class="num">{r.summary.keywords.ranked}</td>
                <td class="num">{r.summary.keywords.top10}</td>
                <td class="num">{r.summary.competitors.total}</td>
                <td class="muted">{r.summary.state.lastSuccessAt ? agoText(r.summary.state.lastSuccessAt, now) : t('aso:overview.never')}</td>
                <td>{#if note}<Badge tone={note.tone} icon="alert-triangle">{note.text}</Badge>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if canManage && config}
        <Disclosure summary={t('aso:overview.alerts')} stateKey="aso.alerts">
          <form class="row alerts" onsubmit={saveThreshold} novalidate>
            <div class="field">
              <label for="{uid}-threshold">{t('aso:overview.thresholdLabel')}</label>
              <span class="row inline">
                <input id="{uid}-threshold" class="num-input" inputmode="numeric" maxlength="3" bind:value={threshold} aria-invalid={parsedThreshold === null} />
                <span class="muted">{t('aso:overview.thresholdUnit')}</span>
              </span>
              <p class="hint"><T key="aso:overview.thresholdHint" /></p>
            </div>
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty || parsedThreshold === null}>{t('common:action.save')}</Button>
          </form>
        </Disclosure>
      {/if}
    </div>
  {/if}
</section>

{#snippet addApp(text: string)}<a href={portfolioHref}>{text}</a>{/snippet}

<style>
  .confirm {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }

  .empty p {
    margin: 0 0 var(--space-3);
  }

  .empty p:last-child {
    margin-bottom: 0;
  }

  .applinks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .top {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .moves {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: var(--space-3);
  }

  .h {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .none {
    margin: 0;
  }

  .movers {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .movers li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  .movers li:first-child {
    border-top: 0;
  }

  .starts li {
    align-items: center;
  }

  .hint {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .what {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    min-width: 0;
  }

  .app {
    grid-column: 1 / -1;
    font-size: var(--text-xs);
  }

  .name {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    text-align: left;
  }

  .alerts {
    align-items: flex-end;
    gap: var(--space-3);
  }

  .inline {
    gap: var(--space-2);
    align-items: center;
  }

  .num-input {
    width: 5rem;
  }
</style>
