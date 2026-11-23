<!--
  SourcesPanel: the state of the data sources of the WHOLE scope (one panel, not one per platform), as plain next steps. One summary line: the
  worst state of the platforms, when the data was last read and how often it is synced, and "Sync analytics now" (every platform in scope). Then,
  per platform (a heading only when there are several), each source: its name, a state (words and an icon), the dates it covers, when it was last
  read, a sentence from a fixed vocabulary about what it needs, the last failed read as a fixed sentence (never the store's text), and the next
  step as a button for those who may act (`analytics.manage`: owners and admins) or as words for everyone else. A file import is always offered (an
  Apple report, or for Android a Play Console statistics CSV), one button per platform. The last manual sync lists what each source did.
  Props: api, workspaceId, items ({ app, status } per platform in scope), role, now, onchanged (called after something changed, so the screen reads again).
  Nothing here changes a store; "Enable Apple analytics" and "Import a report file" open their own dialogs with a preview and a confirmation.
-->
<script lang="ts">
  import { can, platformSupports, type Platform, type Role } from '@kiln/core';
  import { t } from '../../lib/i18n/t.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, type StepAction, stateInfo, stateLabel, stepAvailable } from '../../lib/analytics/analytics.ts';
  import { latestRead, worstState } from '../../lib/analytics/sections.ts';
  import { lastReadAt, overallState, scheduleText, sourceRows } from '../../lib/analytics/view.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { describeError, platformLabel } from '../../lib/portfolio.ts';
  import { openStatusPopover } from '../../lib/app-page.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import EnableAppleDialog from './EnableAppleDialog.svelte';
  import SourceGuide from './SourceGuide.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import TurnOnAnalytics from './TurnOnAnalytics.svelte';

  type Item = { app: { id: string; platform: Platform }; status: AnalyticsStatus };
  let { api, workspaceId, items, role, now, onchanged }: { api: Api; workspaceId: string; items: Item[]; role: Role; now: number; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const groups = $derived(
    items.map((it) => ({
      ...it,
      apple: platformSupports(it.app.platform, 'appleAnalyticsReports'),
      rows: sourceRows(it.status, now),
      mode: modeOf(it.status),
    })),
  );
  const several = $derived(groups.length > 1);
  /** One "Turn on analytics" button for the whole panel, on the first source that asks for it. */
  const firstTurnOn = $derived.by(() => {
    for (let g = 0; g < groups.length; g++) {
      const at = groups[g]?.rows.findIndex((r) => r.action?.kind === 'turn_on') ?? -1;
      if (at >= 0) return `${g}:${at}`;
    }
    return '';
  });
  const overall = $derived(worstState(items.map((it) => overallState(it.status))));
  const last = $derived(latestRead(items.map((it) => lastReadAt(it.status))));
  const anyEnabled = $derived(items.some((it) => it.status.enabled));
  const schedule = $derived(items[0] ? scheduleText(items[0].status) : '');

  function modeOf(status: AnalyticsStatus): string {
    return status.apple
      ? status.apple.mode === 'ongoing'
        ? t('analytics:sources.modeOngoing')
        : status.apple.mode === 'import'
          ? t('analytics:sources.modeImport')
          : t('analytics:sources.modeNone')
      : status.google
        ? status.google.bucketIdSet
          ? status.google.bucketSource === 'app'
            ? t('analytics:sources.bucketApp')
            : status.google.bucketSource === 'account'
              ? t('analytics:sources.bucketAccount')
              : t('analytics:sources.bucketWorkspace')
          : t('analytics:sources.bucketNotSet')
        : '';
  }

  let enableFor = $state<string | null>(null);
  let importFor = $state<string | null>(null);
  const importItem = $derived(groups.find((g) => g.app.id === importFor));

  /** One failed source read again on its own (`POST /analytics/sync` with `sources`): the others are left alone. */
  let retrying = $state<string | null>(null);
  async function retry(appId: string, source: string, label: string) {
    if (retrying !== null) return;
    retrying = `${appId}:${source}`;
    try {
      const done = await api.syncAnalytics(workspaceId, appId, [source]);
      if (done.sync.sources.some((s) => s.source === source && s.status === 'failed')) toast.error(t('analytics:sources.retryStillFailed', { source: label }));
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      retrying = null;
      onchanged();
    }
  }

  function run(action: StepAction, appId: string) {
    if (action.kind === 'enable_apple') enableFor = appId;
    else if (action.kind === 'import') importFor = appId;
  }
</script>

<div class="stack">
  <div class="summary row">
    <Badge tone={stateInfo[overall].tone} icon={stateInfo[overall].icon}>{stateLabel(overall)}</Badge>
    <span class="muted text">
      {last === null ? t('analytics:sources.notReadYet') : t('analytics:sources.lastReadSentence', { ago: timeAgo(last, now) })}
      {schedule}
    </span>
    <span class="spacer"></span>
    {#if anyEnabled}
      <Button size="sm" variant="link" onclick={() => openStatusPopover()}>{t('app:sync.seeStatus')}</Button>
    {/if}
    {#if canManage}
      {#each groups as g (g.app.id)}
        <Button size="sm" icon="upload" onclick={() => (importFor = g.app.id)}>
          {g.apple ? t('analytics:step.importAppleReport') : t('analytics:sources.importPlayCsv')}{#if several}<span class="visually-hidden"> ({platformLabel(g.app.platform)})</span>{/if}
        </Button>
      {/each}
    {/if}
  </div>
  {#each groups as g, gi (g.app.id)}
    <div class="group">
      {#if several}<h3 class="plat"><PlatformBadge platform={g.app.platform} tinted /></h3>{/if}
      {#if g.mode}
        <Disclosure summary={t('analytics:sources.whereFrom')}>
          <p class="message">{g.mode}</p>
        </Disclosure>
      {/if}
      <ul class="sources">
        {#each g.rows as row, ri (row.source)}
          <li>
            <div class="line">
              <strong>{row.label}</strong>
              <Badge tone={row.tone} icon={row.icon}>{row.optional ? t('analytics:sources.optionalSetup') : row.stateLabel}</Badge>
              <span class="muted text">{row.range ? t('analytics:sources.lastReadCovers', { lastRead: row.lastRead, range: row.range }) : row.lastRead}</span>
            </div>
            <p class="message">{row.message}</p>
            {#if row.error}<p class="error-line"><strong>{t('analytics:sources.lastReadFailed')}</strong> {row.error}</p>{/if}
            {#if row.guide !== null || (row.testable && canManage && (row.state === 'error' || row.state === 'needs_setup'))}
              <SourceGuide {api} {workspaceId} app={g.app} {role} source={row.source} kind={row.guide} status={g.status} {onchanged} />
            {/if}
            {#if row.action || row.alternatives.length > 0}
              <div class="actions">
                {#each row.action ? [row.action, ...row.alternatives] : row.alternatives as action, i (action.label)}
                  {#if action.kind === 'turn_on'}
                    {#if !canManage}<span class="muted text">{t('analytics:sources.askTurnOn')}</span>{:else if `${gi}:${ri}` === firstTurnOn}<TurnOnAnalytics {api} {workspaceId} {onchanged} variant={i === 0 ? 'primary' : 'secondary'} />{/if}
                  {:else if action.kind === 'link'}
                    <Button variant="secondary" href={action.target === 'settings' ? '#/settings?view=analytics' : '#/credentials'}>{action.label}</Button>
                  {:else if action.kind === 'bucket'}
                    {#if canManage}
                      <Button variant="secondary" href={appAddress(g.app.id, 'settings', 'android')}>{t('analytics:sources.setBucket')}</Button>
                    {:else}
                      <span class="muted text">{t('analytics:sources.needsAdminBucket')}</span>
                    {/if}
                  {:else if action.kind === 'text'}
                    <span class="muted text">{t('analytics:sources.nextStep', { label: action.label })}</span>
                  {:else if action.kind === 'sync'}
                    {#if canManage && row.state === 'error'}
                      <Button size="sm" icon="refresh" loading={retrying === `${g.app.id}:${row.source}`} disabled={retrying !== null} onclick={() => retry(g.app.id, row.source, row.label)}>{t('app:syncButton.retrySource')}<span class="visually-hidden"> ({row.label})</span></Button>
                    {/if}
                    <Button variant="link" onclick={() => openStatusPopover()}>{t('app:sync.seeStatus')}</Button>
                  {:else if stepAvailable(action, canManage)}
                    <Button variant={i === 0 ? 'primary' : 'secondary'} icon={action.kind === 'import' ? 'upload' : undefined} onclick={() => run(action, g.app.id)}>{action.label}</Button>
                  {:else}
                    <span class="muted text">{t('analytics:sources.needsAdminAction', { action: action.label })}</span>
                  {/if}
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

{#each groups as g (g.app.id)}
  {#if canManage && g.apple}
    <EnableAppleDialog bind:open={() => enableFor === g.app.id, (v) => { if (!v && enableFor === g.app.id) enableFor = null; }} {api} {workspaceId} appId={g.app.id} onenabled={onchanged} onimport={() => (importFor = g.app.id)} />
  {/if}
{/each}
{#if canManage && importItem}
  <ImportReportDialog bind:open={() => importFor !== null, (v) => { if (!v) importFor = null; }} {api} {workspaceId} appId={importItem.app.id} android={!importItem.apple} onimported={onchanged} />
{/if}

<style>
  .group + .group {
    padding-top: var(--space-4);
    margin-top: var(--space-4);
    border-top: 2px solid var(--line);
  }

  .plat {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .summary {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .text {
    font-size: 0.9375rem;
  }


  .sources {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .sources li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) 0;
    border-top: 1px solid var(--line);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .message,
  .error-line {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
</style>
