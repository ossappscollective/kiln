<!--
  EasUpdateBody: the inside of the EAS Update card. Reads `GET /apps/{appId}/expo/updates` when it is drawn (the card draws it only while open)
  and on "Read again". Shows the warnings first (a channel whose newest update has a runtime version that no store build has, or that
  reaches an older build only), then each channel: the branch it points to, the runtime check, the rollouts in progress and the newest
  updates by branch. Insights of an update group are read on request. With the server switch on and the right of a rollout, a rollout in
  progress can be raised (EasRolloutDialog); nothing else here changes Expo.
  Props: api, workspaceId, role, app, onread? (called with the view and whether a read is running, for the collapsed summary).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    type EasUpdateChannel,
    type EasUpdateInsights,
    type EasUpdateState,
    branchHasUpdates,
    channelsWithMismatch,
    comparedBuildTotal,
    updateGroupTotal,
    checkLabel,
    checkTone,
    easUpdateErrorText,
    insightLines,
    mappingText,
    readCaption,
    updateDetail,
    updateTitle,
  } from '../../lib/eas/eas-update.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import EasRolloutDialog from './EasRolloutDialog.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    onread,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    onread?: ((view: EasUpdateState | null, loading: boolean) => void) | undefined;
  } = $props();

  let view = $state<EasUpdateState | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let now = $state(Date.now());
  let generation = 0;

  type InsightsEntry = { loading: boolean; error: string; data: EasUpdateInsights | null };
  let insights = $state<Record<string, InsightsEntry>>({});
  let raising = $state<{ group: string; current: number; channel: string; branch: string } | null>(null);
  let dialogOpen = $state(false);
  let raisedNotice = $state('');

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    onread?.(view, true);
    try {
      const read = await api.easUpdates(workspaceId, app.id);
      if (mine !== generation) return;
      view = read.state;
      now = Date.now();
      insights = {};
      onread?.(read.state, false);
    } catch (e) {
      if (mine !== generation) return;
      problem = easUpdateErrorText(e);
      onread?.(view, false);
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    untrack(() => {
      view = null;
      insights = {};
      raisedNotice = '';
      void load();
    });
  });

  async function readInsights(group: string) {
    if (insights[group]?.loading) return;
    insights = { ...insights, [group]: { loading: true, error: '', data: insights[group]?.data ?? null } };
    try {
      const done = await api.easUpdateInsights(workspaceId, app.id, group);
      insights = { ...insights, [group]: { loading: false, error: '', data: done.insights } };
    } catch (e) {
      insights = { ...insights, [group]: { loading: false, error: easUpdateErrorText(e), data: null } };
    }
  }

  const problems = $derived(view ? channelsWithMismatch(view) : []);
  const anyProblems = $derived(problems.length > 0);
  const mayRaise = $derived(view !== null && view.rolloutWriteEnabled && can(role, 'releases.rollout'));

  function raise(channel: EasUpdateChannel, r: EasUpdateChannel['rollouts'][number]) {
    raising = { group: r.group, current: r.percentage, channel: channel.name, branch: r.branch };
    dialogOpen = true;
  }

  function raised(message: string) {
    raisedNotice = message;
    void load();
  }
</script>

<div class="stack loose" aria-busy={loading}>
  {#if loading && !view}
    <div class="stack" role="status" aria-label={t('eas:update.body.reading')}>
      <Skeleton width="70%" height="16px" />
      <Skeleton width="55%" height="16px" />
      <Skeleton width="62%" height="16px" />
    </div>
  {:else if problem && !view}
    <div class="stack">
      <Alert tone="error" title={t('eas:update.body.readErrorTitle')}>{problem}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('eas:config.body.tryAgain')}</Button></div>
    </div>
  {:else if view}
    {#if problem}<Alert tone="warn" title={t('eas:config.body.rereadErrorTitle')}>{t('eas:config.body.rereadError', { problem })}</Alert>{/if}
    {#if raisedNotice}<Alert tone="ok" ondismiss={() => (raisedNotice = '')}>{raisedNotice}</Alert>{/if}
    <div class="row caption">
      <span class="muted text-sm">{readCaption(view, now)} <span class="mono">{view.project.fullName}</span></span>
      <span class="spacer"></span>
      <Button size="sm" icon="refresh" {loading} onclick={load}>{t('eas:config.body.readAgain')}</Button>
    </div>

    {#if anyProblems}
      <div class="stack tight" data-testid="eas-update-warnings">
        {#each problems as channel (channel.id)}
          <Alert tone={channel.runtimeCheck.severity === 'error' ? 'error' : 'warn'} title={t('eas:update.body.channelAlert', { name: channel.name, check: checkLabel(channel.runtimeCheck.status) })}>
            {channel.runtimeCheck.message}
          </Alert>
        {/each}
      </div>
    {/if}

    {#if view.channels.length === 0}
      <EmptyState icon="git-branch" title={t('eas:update.body.noChannelsTitle')} description={t('eas:update.body.noChannelsDesc')} />
    {:else}
      {#each view.channels as channel (channel.id)}
        {@const updateCount = updateGroupTotal(channel)}
        <section class="channel stack tight" aria-label={t('eas:update.body.channelLabel', { name: channel.name })}>
          <div class="row head">
            <strong>{channel.name}</strong>
            <Badge tone={checkTone(channel.runtimeCheck)}>{checkLabel(channel.runtimeCheck.status)}</Badge>
            {#if channel.isPaused}<Badge tone="warn">{t('eas:update.body.paused')}</Badge>{/if}
            {#if channel.isProtected}<Badge tone="info">{t('eas:update.body.protected')}</Badge>{/if}
          </div>
          <p class="text-sm">{mappingText(channel)}</p>
          {#if channel.runtimeCheck.status === 'ok' || channel.runtimeCheck.severity === 'info'}
            <p class="muted text-sm">{channel.runtimeCheck.message}</p>
          {/if}

          {#each channel.rollouts as r (r.updateId)}
            <div class="rollout row">
              <span class="text-sm">
                {#if r.runtimeVersion}
                  <T key="eas:update.body.rolloutRuntime" params={{ group: r.group.slice(0, 8), branch: r.branch, percentage: r.percentage, runtime: r.runtimeVersion }} tags={{ link: mono }} />
                {:else}
                  <T key="eas:update.body.rollout" params={{ group: r.group.slice(0, 8), branch: r.branch, percentage: r.percentage }} tags={{ link: mono }} />
                {/if}
              </span>
              <span class="spacer"></span>
              {#if mayRaise}<Button size="sm" onclick={() => raise(channel, r)}>{t('eas:update.body.raise')}</Button>{/if}
            </div>
          {/each}

          {#if updateCount === 0}
            <p class="muted text-sm">{t('eas:update.body.noUpdates')}</p>
          {:else}
            <Disclosure summary={t('eas:update.body.newest', { count: updateCount })} stateKey="eas-update-{app.id}-{channel.id}">
              <div class="stack tight">
                {#each channel.branches as branch (branch.id)}
                  {#if branchHasUpdates(branch)}
                    <div class="stack tight">
                      <span class="text-sm"><strong>{t('eas:update.body.branch', { name: branch.name })}</strong>{#if !branch.mapped} <span class="muted">{t('eas:update.body.notMapped')}</span>{/if}</span>
                      <ul class="plain stack tight">
                        {#each branch.groups as g (g.group)}
                          {#each g.updates as u (u.id)}
                            {@const entry = insights[g.group]}
                            <li class="update">
                              <div class="row">
                                <span class="what">
                                  {updateTitle(u)}
                                  <span class="muted text-sm">{updateDetail(u, now)}</span>
                                  {#if u.rolloutPercentage !== null}<Badge tone="info">{t('eas:update.body.rolloutBadge', { percent: u.rolloutPercentage })}</Badge>{/if}
                                </span>
                                <span class="spacer"></span>
                                <Button size="sm" variant="ghost" loading={entry?.loading === true} onclick={() => readInsights(g.group)}>{t('eas:update.body.insights')}</Button>
                              </div>
                              {#if entry?.error}<p class="text-sm err">{entry.error}</p>{/if}
                              {#if entry?.data}
                                <dl class="facts">
                                  {#each insightLines(entry.data) as line (line.label)}
                                    <dt class="muted">{line.label}</dt>
                                    <dd>{line.text}</dd>
                                  {/each}
                                </dl>
                                <p class="muted text-sm">{t('eas:update.body.insightsDays', { count: entry.data.days })}</p>
                              {/if}
                            </li>
                          {/each}
                        {/each}
                      </ul>
                    </div>
                  {/if}
                {/each}
              </div>
            </Disclosure>
          {/if}
        </section>
      {/each}
      {#if view.channelsTruncated}
        <p class="muted text-sm">{t('eas:update.body.truncated')}</p>
      {/if}
    {/if}

    {#if comparedBuildTotal(view) > 0}
      <Disclosure summary={t('eas:update.body.buildsCompared', { count: comparedBuildTotal(view) })} stateKey="eas-update-builds-{app.id}">
        <div class="table-wrap">
          <table class="compact">
            <caption class="visually-hidden">{t('eas:update.body.buildsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('eas:update.body.colVersion')}</th>
                <th scope="col">{t('eas:config.runtime.label')}</th>
                <th scope="col">{t('eas:update.body.colChannel')}</th>
              </tr>
            </thead>
            <tbody>
              {#each view.builds as b (b.id)}
                <tr>
                  <td>{b.appVersion ?? t('eas:update.body.unknown')}{#if b.appBuildVersion} <span class="muted">({b.appBuildVersion})</span>{/if}</td>
                  <td class="mono">{b.runtimeVersion ?? t('eas:update.body.none')}</td>
                  <td>{b.channel ?? t('eas:update.body.none')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="muted text-sm">{t('eas:update.body.buildsNote')}</p>
      </Disclosure>
    {/if}
  {/if}
</div>

{#snippet mono(text: string)}<span class="mono">{text}</span>{/snippet}

{#if raising}
  {#key raising.group}
    <EasRolloutDialog
      bind:open={dialogOpen}
      {api}
      {workspaceId}
      appId={app.id}
      appName={app.name}
      target={raising}
      ondone={raised}
      onclose={() => (raising = null)}
    />
  {/key}
{/if}

<style>
  .caption {
    align-items: center;
    gap: var(--space-3);
  }

  .channel {
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .head {
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .rollout {
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--surface-sunken, var(--surface-2, transparent));
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .update {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow-wrap: anywhere;
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .facts {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) 1fr;
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt,
  .facts dd {
    margin: 0;
  }

  .err {
    color: var(--danger, inherit);
    margin: 0;
  }
</style>
