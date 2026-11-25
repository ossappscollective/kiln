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
  import { formatNumber, formatTime } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { type Msg, msg, msgText } from '../../lib/message.ts';
  import T from '../ui/T.svelte';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
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
  import { publishingStore } from '../../lib/publishing-store.svelte.ts';
  import { irreversibleLine, rolloutNowLine } from '../../lib/release-detail.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import PublishingNote from '../publish/PublishingNote.svelte';
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
  let readError = $state<Msg | null>(null);
  /** Why the change buttons are off even though a state is shown: an unknown outcome, or a result not yet re-read. */
  let blocked = $state<string | null>(null);
  let notice = $state<{ tone: 'info' | 'warn' | 'error' | 'ok'; title: Msg; text: Msg } | null>(null);
  let sharing = $state(false);
  let percent = $state('');
  let percentProblem = $state<Msg | null>(null);
  let preview = $state<RolloutPreview | null>(null);
  /** The change the preview was made for: apply sends exactly this plus the hash (the hash covers it). */
  let previewed: RolloutRequest | null = null;
  let dialogOpen = $state(false);
  let previewing = $state('');
  let applying = $state(false);
  let dialogProblem = $state<Msg | null>(null);
  let dialogNotice = $state<Msg | null>(null);
  let result = $state<RolloutResult | null>(null);
  let seq = 0;

  const target = $derived(targets.filter((tg) => tg.key === targetKey)[0] ?? null);
  const buttons = $derived(actionButtons(config, app.platform, view, reading || applying ? t('release-store:ra.wait') : blocked !== null ? t(blocked) : null));

  // Another app, or a list of releases without the chosen one, starts clean.
  $effect(() => {
    const first = targets[0]?.key ?? '';
    const has = targets.some((tg) => tg.key === untrack(() => targetKey));
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
    readError = null;
    blocked = null;
    notice = null;
    sharing = false;
    percent = '';
    percentProblem = null;
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
    readError = null;
    try {
      const done = await api.rolloutState(workspaceId, app.id, stateQuery(target.base));
      if (mine !== seq) return;
      view = done;
      blocked = null;
      notice = null;
      result = null;
    } catch (e) {
      if (mine !== seq) return;
      readError = classifyFailure(e, null).text;
    } finally {
      if (mine === seq) reading = false;
    }
  }

  /** A batch publish of this app runs on the server: changing the rollout now would race it. */
  const publishingNow = $derived(publishingStore.isPublishing(workspaceId, app.id));

  function begin(action: string) {
    if (publishingNow) return;
    if (action === 'set_fraction') {
      sharing = !sharing;
      percentProblem = null;
      return;
    }
    void startPreview(action);
  }

  function submitShare() {
    const checked = parsePercent(percent, view?.minUserFraction ?? null);
    if (!checked.ok) {
      percentProblem = checked.text;
      return;
    }
    percentProblem = null;
    void startPreview('set_fraction', checked.fraction);
  }

  async function startPreview(action: string, fraction?: number) {
    if (!target || previewing !== '' || applying) return;
    const mine = ++seq;
    previewing = action;
    notice = null;
    dialogProblem = null;
    dialogNotice = null;
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
      notice = { tone: 'error', title: msg(k('release-store:ra.noPreview')), text: failure.text };
    } finally {
      if (mine === seq) previewing = '';
    }
  }

  function closeDialog() {
    dialogOpen = false;
    preview = null;
    previewed = null;
    dialogProblem = null;
    dialogNotice = null;
  }

  async function confirm() {
    if (!preview || !previewed || applying) return;
    const sent = preview;
    const mine = ++seq;
    applying = true;
    dialogProblem = null;
    try {
      // The same change as the preview, with its hash. This is the only call that writes to the store, and it is sent once.
      const body = { ...previewed, confirmHash: sent.confirmHash };
      const done = await confirmed((grant) => api.rolloutApply(workspaceId, app.id, body, grant), sent.confirmHash);
      if (mine !== seq) return;
      result = done.result;
      closeDialog();
      blocked = k('release-store:ra.blockedMade');
      sharing = false;
      percent = '';
      notice = {
        tone: 'ok',
        title: done.result.confirmedByReread ? msg(k('release-store:ra.doneConfirmed')) : msg(k('release-store:ra.done')),
        text: msg(k('release-store:ra.doneText'), () => ({ state: describeState(done.result.after), note: done.result.note })),
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
          dialogNotice = msg(k('release-store:ra.changedAfterPreview'));
          dialogProblem = null;
        } else {
          closeDialog();
          notice = { tone: 'warn', title: msg(k('release-store:ra.storeChanged')), text: msg(k('release-store:ra.noLongerFits'), () => ({ message: failure.message })) };
          blocked = k('release-store:ra.blockedRefresh');
        }
        break;
      case 'write_in_progress':
        dialogProblem = msg(k('release-store:ra.waitConfirm'), () => ({ message: failure.message }));
        break;
      case 'outcome_unknown':
        closeDialog();
        blocked = k('release-store:ra.blockedUnknown');
        notice = { tone: 'error', title: msg(k('release-store:ra.unknown')), text: failure.text };
        break;
      case 'not_applied':
        closeDialog();
        notice = { tone: 'info', title: msg(k('release-store:ra.nothingChanged')), text: failure.text };
        break;
      case 'disabled':
        closeDialog();
        notice = { tone: 'warn', title: msg(k('release-store:ra.switchedOff')), text: failure.text };
        break;
      default:
        dialogProblem = failure.text;
    }
  }

  const shareId = $derived(`${uid}-share`);
  /** The one short line next to the buttons: which enabled changes cannot be undone. */
  const warning = $derived(irreversibleLine(buttons));
</script>

<div class="app card" data-testid="rollout-app">
  <div class="head">
    <h4><PlatformBadge platform={app.platform} tinted /> <span class="muted">{app.name} · {platformLabel(app.platform)}</span></h4>
  </div>

  {#if targets.length === 0}
    <p class="muted note">
      {app.lastSyncedAt === null ? t('release-store:ra.notSynced') : t('release-store:ra.noRelease')}
    </p>
  {:else}
    <div class="row wrap">
      <label for="{uid}-release">{t('release-store:ra.release')}</label>
      <select id="{uid}-release" value={targetKey} disabled={reading || applying} onchange={(e) => pick(e.currentTarget.value)}>
        {#each targets as tg (tg.key)}<option value={tg.key}>{tg.label}</option>{/each}
      </select>
      <Button size="sm" icon="refresh" loading={reading} disabled={applying || previewing !== ''} onclick={refresh}>
        {view ? t('release-store:ra.refresh') : t('release-store:ra.readState')}
      </Button>
    </div>

    {#if readError}<Alert tone="error">{msgText(readError)}</Alert>{/if}

    {#if view}
      <p class="state" aria-live="polite" title={describeState(view.current)}>
        <strong class="now">{rolloutNowLine(view.current)}</strong>
        <span class="muted">{t('release-store:ra.readAt', { time: formatTime(view.readAt) })}</span>
      </p>
    {:else if !readError}
      <p class="muted note">{t('release-store:ra.readFirst')}</p>
    {/if}

    {#if notice}<Alert tone={notice.tone} title={msgText(notice.title)}>{msgText(notice.text)}</Alert>{/if}
    {#if blocked && !notice}<p class="muted note">{t(blocked)}</p>{/if}

    <div class="row wrap actions">
      {#each buttons as b (b.action)}
        <Button
          variant={b.irreversible ? 'danger' : 'secondary'}
          disabled={b.disabled || publishingNow}
          title={publishingNow ? publishingStore.reason(workspaceId, app.id) : (b.reason ?? undefined)}
          loading={previewing === b.action}
          onclick={() => begin(b.action)}
        >
          {b.action === 'set_fraction' ? t('release-store:ra.ellipsis', { label: b.label }) : b.label}
        </Button>
      {/each}
    </div>
    <PublishingNote {workspaceId} appId={app.id} />
    {#if warning}<p class="irreversible" data-testid="rollout-irreversible">{warning}</p>{/if}

    {#if sharing && view}
      <div class="field share">
        <label for={shareId}>{t('release-store:ra.newShare', { min: formatNumber(view.minUserFraction !== null ? Math.round(view.minUserFraction * 10000) / 100 : 0) })}</label>
        <div class="row">
          <input id={shareId} type="text" inputmode="decimal" autocomplete="off" bind:value={percent} aria-invalid={percentProblem !== null} />
          <Button size="sm" variant="primary" loading={previewing === 'set_fraction'} disabled={previewing !== ''} onclick={submitShare}>{t('release-store:ra.previewChange')}</Button>
        </div>
        {#if percentProblem}<p class="error" role="alert">{msgText(percentProblem)}</p>{/if}
        <p class="hint">{t('release-store:ra.raiseOnly')}</p>
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
      problem={msgText(dialogProblem)}
      notice={msgText(dialogNotice)}
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
    font-size: 0.9375rem;
  }

  .state {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: baseline;
  }

  .now {
    font-size: var(--text-md);
  }

  .irreversible {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: var(--weight-semibold);
    color: var(--warn-ink, var(--text));
  }

  .share {
    max-width: 28rem;
  }

  .error {
    margin: 0;
    color: var(--bad-ink);
    font-size: 0.9375rem;
  }
</style>
