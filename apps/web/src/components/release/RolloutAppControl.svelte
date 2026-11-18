<!--
  RolloutAppControl: the store rollout controls of ONE platform record of an app: pick the release, read its
  state from the store, then change it through a preview and a confirmation (docs/api/rollout.md).
  Props: api, workspaceId, app, releases (the app's releases from the last sync), config (the server's
  rollout config; the feature is on).
  Rules it keeps: a preview before every change; the apply sends the preview's hash, once; when the store
  changed meanwhile the new preview replaces the old one and must be confirmed again; an unknown outcome is
  never retried: the controls stay blocked until the state is read from the store successfully.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type RolloutConfig,
    type RolloutFailure,
    type RolloutPreview,
    type RolloutRequest,
    type RolloutResult,
    type RolloutStateView,
    actionButtons,
    buildRequest,
    classifyFailure,
    describeState,
    parsePercent,
    rolloutTargets,
    stateQuery,
  } from '../../lib/store-rollout.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import RolloutPreviewDialog from './RolloutPreviewDialog.svelte';

  let {
    api,
    workspaceId,
    app,
    releases,
    config,
  }: {
    api: Api;
    workspaceId: string;
    app: AppSummary;
    releases: ReleaseSummary[];
    config: RolloutConfig;
  } = $props();

  const uid = $props.id();
  const targets = $derived(rolloutTargets(app, releases));

  let targetKey = $state('');
  let view = $state<RolloutStateView | null>(null);
  let reading = $state(false);
  let readError = $state('');
  /** Why the change buttons are off even though a state is shown: an unknown outcome, or a result not yet re-read. */
  let blocked = $state<string | null>(null);
  let notice = $state<{ tone: 'info' | 'warn' | 'error' | 'ok'; title: string; text: string } | null>(null);
  let sharing = $state(false);
  let percent = $state('');
  let percentProblem = $state('');
  let preview = $state<RolloutPreview | null>(null);
  /** The change the preview was made for: apply sends exactly this plus the hash (the hash covers it). */
  let previewed: RolloutRequest | null = null;
  let dialogOpen = $state(false);
  let previewing = $state('');
  let applying = $state(false);
  let dialogProblem = $state('');
  let dialogNotice = $state('');
  let result = $state<RolloutResult | null>(null);
  let seq = 0;

  const target = $derived(targets.filter((t) => t.key === targetKey)[0] ?? null);
  const buttons = $derived(actionButtons(config, app.platform, view, reading || applying ? 'Wait for the request to finish.' : blocked));

  // Another app, or a list of releases without the chosen one, starts clean.
  $effect(() => {
    const first = targets[0]?.key ?? '';
    const has = targets.some((t) => t.key === untrack(() => targetKey));
    if (!has) {
      untrack(() => {
        targetKey = first;
        reset();
      });
    }
  });

  function reset() {
    seq++;
    view = null;
    readError = '';
    blocked = null;
    notice = null;
    sharing = false;
    percent = '';
    percentProblem = '';
    preview = null;
    dialogOpen = false;
    previewing = '';
    applying = false;
    result = null;
    reading = false;
  }

  function pick(key: string) {
    targetKey = key;
    reset();
  }

  /** Reads the store: changes nothing, and a successful read settles an earlier unknown outcome. */
  async function refresh() {
    if (!target || reading || applying) return;
    const mine = ++seq;
    reading = true;
    readError = '';
    try {
      const done = await api.rolloutState(workspaceId, app.id, stateQuery(target.base));
      if (mine !== seq) return;
      view = done;
      blocked = null;
      notice = null;
      result = null;
    } catch (e) {
      if (mine !== seq) return;
      readError = classifyFailure(e, null).message;
    } finally {
      if (mine === seq) reading = false;
    }
  }

  function begin(action: string) {
    if (action === 'set_fraction') {
      sharing = !sharing;
      percentProblem = '';
      return;
    }
    void startPreview(action);
  }

  function submitShare() {
    const checked = parsePercent(percent, view?.minUserFraction ?? null);
    if (!checked.ok) {
      percentProblem = checked.message;
      return;
    }
    percentProblem = '';
    void startPreview('set_fraction', checked.fraction);
  }

  async function startPreview(action: string, fraction?: number) {
    if (!target || previewing !== '' || applying) return;
    const mine = ++seq;
    previewing = action;
    notice = null;
    dialogProblem = '';
    dialogNotice = '';
    try {
      const request = buildRequest(target.base, action, fraction);
      const done = await api.rolloutPreview(workspaceId, app.id, request);
      if (mine !== seq) return;
      previewed = request;
      preview = done.preview;
      dialogOpen = true;
    } catch (e) {
      if (mine !== seq) return;
      const failure = classifyFailure(e, null);
      notice = { tone: 'error', title: 'No preview was made', text: failure.message };
    } finally {
      if (mine === seq) previewing = '';
    }
  }

  function closeDialog() {
    dialogOpen = false;
    preview = null;
    previewed = null;
    dialogProblem = '';
    dialogNotice = '';
  }

  async function confirm() {
    if (!preview || !previewed || applying) return;
    const sent = preview;
    const mine = ++seq;
    applying = true;
    dialogProblem = '';
    try {
      // The same change as the preview, with its hash. This is the only call that writes to the store, and it is sent once.
      const body = { ...previewed, confirmHash: sent.confirmHash };
      const done = await api.rolloutApply(workspaceId, app.id, body);
      if (mine !== seq) return;
      result = done.result;
      closeDialog();
      blocked = 'The change was made. Refresh the state to see what the store shows and allows now.';
      sharing = false;
      percent = '';
      notice = {
        tone: 'ok',
        title: done.result.confirmedByReread ? 'Done (confirmed by reading the store back)' : 'Done',
        text: `${describeState(done.result.after)}. ${done.result.note}`,
      };
    } catch (e) {
      if (mine !== seq) return;
      handleFailure(classifyFailure(e, sent));
    } finally {
      if (mine === seq) applying = false;
    }
  }

  function handleFailure(failure: RolloutFailure) {
    switch (failure.kind) {
      case 'state_changed':
        if (failure.next) {
          // The store is not what was previewed. Nothing was written. Show the new preview: it must be confirmed again.
          preview = failure.next;
          dialogNotice = 'The store changed after you previewed this, so nothing was sent. The numbers below are the new ones; read them and confirm again.';
          dialogProblem = '';
        } else {
          closeDialog();
          notice = { tone: 'warn', title: 'The store changed', text: `${failure.message} That change no longer fits the state of the store.` };
          blocked = 'Refresh the state to see what the store shows now.';
        }
        break;
      case 'write_in_progress':
        dialogProblem = `${failure.message} Wait a moment, then confirm again.`;
        break;
      case 'outcome_unknown':
        closeDialog();
        blocked = 'The outcome of the last change is not known. Refresh the state from the store before changing anything.';
        notice = { tone: 'error', title: 'Not known whether the change was made', text: failure.message };
        break;
      case 'not_applied':
        closeDialog();
        notice = { tone: 'info', title: 'Nothing was changed', text: failure.message };
        break;
      case 'disabled':
        closeDialog();
        notice = { tone: 'warn', title: 'Switched off', text: failure.message };
        break;
      default:
        dialogProblem = failure.message;
    }
  }

  const shareId = $derived(`${uid}-share`);
</script>

<div class="app card" data-testid="rollout-app">
  <div class="head">
    <h4><PlatformBadge platform={app.platform} tinted /> <span class="muted">{app.name} · {platformLabel(app.platform)}</span></h4>
  </div>

  {#if targets.length === 0}
    <p class="muted note">
      {app.lastSyncedAt === null
        ? 'This app was not synced yet, so there is no release to change. Sync it first.'
        : 'The last sync found no release here that a rollout change can name.'}
    </p>
  {:else}
    <div class="row wrap">
      <label for="{uid}-release">Release</label>
      <select id="{uid}-release" value={targetKey} disabled={reading || applying} onchange={(e) => pick(e.currentTarget.value)}>
        {#each targets as t (t.key)}<option value={t.key}>{t.label}</option>{/each}
      </select>
      <Button size="sm" icon="refresh" loading={reading} disabled={applying || previewing !== ''} onclick={refresh}>
        {view ? 'Refresh state' : 'Read state from the store'}
      </Button>
    </div>

    {#if readError}<Alert tone="error">{readError}</Alert>{/if}

    {#if view}
      <p class="state" aria-live="polite">
        <strong>In the store now:</strong> {describeState(view.current)}
        <span class="muted">(read {new Date(view.readAt).toLocaleTimeString()})</span>
      </p>
    {:else if !readError}
      <p class="muted note">Read the state from the store first: this only reads, it changes nothing.</p>
    {/if}

    {#if notice}<Alert tone={notice.tone} title={notice.title}>{notice.text}</Alert>{/if}
    {#if blocked && !notice}<p class="muted note">{blocked}</p>{/if}

    <div class="row wrap actions">
      {#each buttons as b (b.action)}
        <Button
          size="sm"
          variant={b.irreversible ? 'danger' : 'secondary'}
          disabled={b.disabled}
          title={b.reason ?? undefined}
          loading={previewing === b.action}
          onclick={() => begin(b.action)}
        >
          {b.label}{b.action === 'set_fraction' ? '…' : ''}
        </Button>
        {#if b.irreversible && !b.disabled}<Badge tone="warn">cannot be undone</Badge>{/if}
      {/each}
    </div>

    {#if sharing && view}
      <div class="field share">
        <label for={shareId}>New share of users (percent, more than {view.minUserFraction !== null ? Math.round(view.minUserFraction * 10000) / 100 : 0}%)</label>
        <div class="row">
          <input id={shareId} type="text" inputmode="decimal" autocomplete="off" bind:value={percent} aria-invalid={percentProblem !== ''} />
          <Button size="sm" variant="primary" loading={previewing === 'set_fraction'} disabled={previewing !== ''} onclick={submitShare}>Preview change</Button>
        </div>
        {#if percentProblem}<p class="error" role="alert">{percentProblem}</p>{/if}
        <p class="hint">Google Play only raises a rollout. The only way down is to halt it.</p>
      </div>
    {/if}
  {/if}
</div>

{#if preview}
  {#key preview.confirmHash}
    <RolloutPreviewDialog
      bind:open={dialogOpen}
      {preview}
      busy={applying}
      problem={dialogProblem}
      notice={dialogNotice}
      onconfirm={confirm}
      oncancel={() => {
        if (!applying) {
          dialogOpen = false;
          preview = null;
          previewed = null;
        }
      }}
    />
  {/key}
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  h4 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-base);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .state,
  .note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .share {
    max-width: 28rem;
  }

  .error {
    margin: 0;
    color: var(--bad-ink);
    font-size: var(--text-sm);
  }
</style>
