<!--
  SourcesPanel: the state of the data sources of one app record, as plain next steps. Per source: its name, a state (words and an
  icon), the dates it covers, when it was last read, a sentence from a fixed vocabulary about what it needs, the last failed
  read as a fixed sentence (never the store's text), and the next step as a button for those who may act (`analytics.manage`:
  owners and admins) or as words for everyone else. Above the list: when the data was last read, how often it is synced, and
  "Sync analytics now". A file import is always offered (an Apple report, or for Android a Play Console statistics CSV). The last manual sync lists what each source did.
  Props: api, workspaceId, app (id and platform), status, role, now, onchanged (called after something changed, so the screen reads again).
  Nothing here changes a store; "Enable Apple analytics" and "Import a report file" open their own dialogs with a preview and a confirmation.
  Readable pass (docs/design/readability.md): 15px text and roomier rows; a source is its name, ONE state word and its next action; where the
  reports come from sits behind a disclosure.
-->
<script lang="ts">
  import { can, platformSupports, type Role } from '@kiln/core';
  import { t } from '../../lib/i18n/t.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, type StepAction, analyticsErrorText, stateInfo, stateLabel, stepAvailable } from '../../lib/analytics/analytics.ts';
  import { type SyncLine, lastReadAt, overallState, scheduleText, sourceRows, syncLines } from '../../lib/analytics/view.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import EnableAppleDialog from './EnableAppleDialog.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import TurnOnAnalytics from './TurnOnAnalytics.svelte';

  let {
    api,
    workspaceId,
    app,
    status,
    role,
    now,
    onchanged,
  }: { api: Api; workspaceId: string; app: { id: string; platform: string }; status: AnalyticsStatus; role: Role; now: number; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const apple = $derived(platformSupports(app.platform, 'appleAnalyticsReports'));
  const rows = $derived(sourceRows(status, now));
  /** One "Turn on analytics" button for the whole list, on the first source that asks for it. */
  const firstTurnOn = $derived(rows.findIndex((r) => r.action?.kind === 'turn_on'));
  const overall = $derived(overallState(status));
  const last = $derived(lastReadAt(status));
  const modeText = $derived(
    status.apple
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
        : '',
  );

  let syncing = $state(false);
  let syncError = $state('');
  let lines = $state<SyncLine[]>([]);
  let enableOpen = $state(false);
  let importOpen = $state(false);

  async function sync() {
    if (syncing) return;
    syncing = true;
    syncError = '';
    lines = [];
    try {
      const result = await api.syncAnalytics(workspaceId, app.id);
      lines = syncLines(result.sync);
      toast.success(result.sync.pointsWritten > 0 ? t('analytics:sources.synced', { count: result.sync.pointsWritten }) : t('analytics:sources.syncedNothing'));
      onchanged();
    } catch (e) {
      syncError = analyticsErrorText(e);
    } finally {
      syncing = false;
    }
  }

  function run(action: StepAction) {
    if (action.kind === 'enable_apple') enableOpen = true;
    else if (action.kind === 'import') importOpen = true;
    else if (action.kind === 'sync') void sync();
  }
</script>

<div class="stack">
  <div class="summary row">
    <Badge tone={stateInfo[overall].tone} icon={stateInfo[overall].icon}>{stateLabel(overall)}</Badge>
    <span class="muted text">
      {last === null ? t('analytics:sources.notReadYet') : t('analytics:sources.lastReadSentence', { ago: timeAgo(last, now) })}
      {scheduleText(status)}
    </span>
    <span class="spacer"></span>
    {#if canManage && status.enabled}
      <Button size="sm" icon="refresh" loading={syncing} onclick={sync}>{syncing ? t('analytics:sources.syncing') : t('analytics:step.syncNow')}</Button>
    {/if}
    {#if canManage}
      <Button size="sm" icon="upload" onclick={() => (importOpen = true)}>{apple ? t('analytics:step.importAppleReport') : t('analytics:sources.importPlayCsv')}</Button>
    {/if}
  </div>

  {#if syncError}<Alert tone="error">{syncError}</Alert>{/if}
  {#if lines.length > 0}
    <ul class="sync" aria-label={t('analytics:sources.syncAria')}>
      {#each lines as line (line.source)}
        <li><strong>{t('analytics:sources.syncLabel', { label: line.label })}</strong> {line.text}</li>
      {/each}
    </ul>
  {/if}

  {#if modeText}
    <Disclosure summary={t('analytics:sources.whereFrom')}>
      <p class="message">{modeText}</p>
    </Disclosure>
  {/if}

  <ul class="sources">
    {#each rows as row, ri (row.source)}
      <li>
        <div class="line">
          <strong>{row.label}</strong>
          <Badge tone={row.tone} icon={row.icon}>{row.optional ? t('analytics:sources.optionalSetup') : row.stateLabel}</Badge>
          <span class="muted text">{row.range ? t('analytics:sources.lastReadCovers', { lastRead: row.lastRead, range: row.range }) : row.lastRead}</span>
        </div>
        <p class="message">{row.message}</p>
        {#if row.error}<p class="error-line"><strong>{t('analytics:sources.lastReadFailed')}</strong> {row.error}</p>{/if}
        {#if row.action || row.alternatives.length > 0}
          <div class="actions">
            {#each row.action ? [row.action, ...row.alternatives] : row.alternatives as action, i (action.label)}
              {#if action.kind === 'turn_on'}
                {#if !canManage}<span class="muted text">{t('analytics:sources.askTurnOn')}</span>{:else if ri === firstTurnOn}<TurnOnAnalytics {api} {workspaceId} {onchanged} variant={i === 0 ? 'primary' : 'secondary'} />{/if}
              {:else if action.kind === 'link'}
                <Button variant="secondary" href={action.target === 'settings' ? '#/settings?view=analytics' : '#/credentials'}>{action.label}</Button>
              {:else if action.kind === 'bucket'}
                {#if canManage}
                  <Button variant="secondary" href={appAddress(app.id, 'settings', 'android')}>{t('analytics:sources.setBucket')}</Button>
                {:else}
                  <span class="muted text">{t('analytics:sources.needsAdminBucket')}</span>
                {/if}
              {:else if action.kind === 'text'}
                <span class="muted text">{t('analytics:sources.nextStep', { label: action.label })}</span>
              {:else if stepAvailable(action, canManage)}
                <Button variant={i === 0 ? 'primary' : 'secondary'} icon={action.kind === 'import' ? 'upload' : action.kind === 'sync' ? 'refresh' : undefined} onclick={() => run(action)}>{action.label}</Button>
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

{#if canManage && apple}
  <EnableAppleDialog bind:open={enableOpen} {api} {workspaceId} appId={app.id} onenabled={onchanged} onimport={() => (importOpen = true)} />
{/if}
{#if canManage}
  <ImportReportDialog bind:open={importOpen} {api} {workspaceId} appId={app.id} android={!apple} onimported={onchanged} />
{/if}

<style>
  .summary {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .text {
    font-size: 0.9375rem;
  }

  .sync {
    padding-left: var(--space-5);
    margin: 0;
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
