<!--
  StoreRelease: the "Release" control of the Confirm step, for one app record, with the dialog behind it. Drawn only for
  admin and up (`store.release`). While the server's switch is off there is no button: the line says so and a small
  popover names KILN_STORE_RELEASE_ENABLED.
  A release is a SEPARATE, IRREVERSIBLE store write: the preview (a store read) comes first; the release is sent once
  with the preview's hash and the typed phrase and is NEVER retried by this app. `state_changed` brings a new preview
  that must be confirmed again; `outcome_unknown` makes the person look at the store console and preview again.
  Google Play: the share of users starts from the staged `user_fraction`, else the default share of the app (settings), and the
  person can change it; the typed phrase of the release confirms it. When no staged rollout is offered (the first release in
  production, or the app setting says never) there is no share input and the release goes to everyone.
  Props: api, workspaceId, role, app ({ id, name, platform }), version (App Store: the marketing version, or null for
  "the one waiting"), track (Google Play), versionCodes (Google Play, optional), stagedShare (the staged intended share
  as text, or ''), stagedFields (Google Play: a track and version codes are staged; the release can then be made from them in one step,
  no draft first, and Google reviews it: a checkbox that starts on, docs/adr/0029-direct-play-release.md), onreleased (called after a
  successful release, so the screen reads the pipeline again).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { announcePublished } from '../../../lib/app-page.ts';
  import type { Api } from '../../../lib/api.ts';
  import { confirmed } from '../../../lib/step-up-prompt.svelte.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import {
    type ReleaseFailure,
    type ReleasePreview,
    type ReleaseResult,
    canRelease,
    classifyReleaseFailure,
    mayConfirmAgain,
    parsePercent,
    percentFromFraction,
    percentText,
    releaseBody,
    releaseLine,
    resultText,
    shouldReloadState,
  } from '../../../lib/store-release.ts';
  import { EVERYONE, releaseInputsFor } from '../../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../../lib/release-settings-store.svelte.ts';
  import { releaseStore } from '../../../lib/store-release-store.svelte.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';
  import StoreReleaseDialog from './StoreReleaseDialog.svelte';
import { supports } from '@kiln/core';

  let {
    api,
    workspaceId,
    role,
    app,
    version = null,
    track = '',
    versionCodes = [],
    stagedShare = '',
    stagedFields = false,
    onreleased,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'name' | 'platform'>;
    version?: string | null | undefined;
    track?: string | undefined;
    versionCodes?: string[] | undefined;
    stagedShare?: string | undefined;
    /** Google Play: a track and version codes are staged, so the release can be made from them in one step. */
    stagedFields?: boolean | undefined;
    onreleased?: (() => void) | undefined;
  } = $props();

  const uid = $props.id();

  type Notice = { tone: 'info' | 'warn' | 'error' | 'ok'; title: string; text: string };

  let previewing = $state(false);
  let applying = $state(false);
  let preview = $state<ReleasePreview | null>(null);
  let dialogOpen = $state(false);
  let dialogProblem = $state('');
  let dialogNotice = $state('');
  let notice = $state<Notice | null>(null);
  let result = $state<ReleaseResult | null>(null);
  let announcement = $state('');
  /** What the person typed as the share, in percent. Never filled in for them. */
  let shareText = $state('');
  /** Google Play: release the staged fields in one step (no draft first). Starts on when something is staged; the person can switch it off. */
  let direct = $state(untrack(() => stagedFields));
  let seq = 0;

  const android = $derived(supports(app.platform, 'releaseTracks'));
  const mayAct = $derived(canRelease(role));
  // The share starts from the default of the app (a staged share wins) and is hidden, with a reason, when Google Play offers no staged
  // rollout. Nothing is confirmed by the start: the typed phrase of the release names the share.
  const inputs = $derived(releaseInputsFor({ view: releaseSettingsStore.get(app.id), track, stagedPercent: percentFromFraction(stagedShare) }));
  const offered = $derived(!android || inputs.offer.offered);
  const fraction = $derived(android ? (offered ? parsePercent(shareText) : EVERYONE) : null);
  const line = $derived(
    releaseLine({
      role,
      platform: app.platform,
      state: releaseStore.state(app.id),
      stateFailed: releaseStore.stateFailed(app.id),
      config: releaseStore.config(workspaceId),
      configFailed: releaseStore.configFailed(workspaceId),
      fraction,
    }),
  );
  const busy = $derived(previewing || applying);
  const reminder = $derived(percentFromFraction(stagedShare));
  const body = $derived(releaseBody(app.platform, { version: version ?? undefined, track: track || undefined, fraction, versionCodes, direct: android && direct && stagedFields }));
  const needsTrack = $derived(android && track.trim() === '');

  let lastStart = $state('');
  $effect(() => {
    const start = inputs.share;
    untrack(() => {
      if (shareText.trim() === '' || shareText === lastStart) shareText = start;
      lastStart = start;
    });
  });

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}/${mayAct}`;
    if (key !== shownFor) {
      shownFor = key;
      untrack(() => {
        seq++;
        preview = null;
        dialogOpen = false;
        notice = null;
        result = null;
        shareText = '';
        lastStart = '';
        if (android) void releaseSettingsStore.load(api, workspaceId, app.id);
        if (mayAct) {
          void releaseStore.load(api, workspaceId, app.id);
          void releaseStore.loadConfig(api, workspaceId);
        }
      });
    }
  });

  function retryReads() {
    void releaseStore.load(api, workspaceId, app.id);
    void releaseStore.loadConfig(api, workspaceId, true);
  }

  async function startPreview() {
    if (busy || line.kind !== 'ready' || line.disabled || needsTrack) return;
    const mine = ++seq;
    previewing = true;
    notice = null;
    result = null;
    dialogProblem = '';
    dialogNotice = '';
    try {
      // Reads the store. Not a write. A successful read also settles an unknown outcome of an earlier release.
      const done = await api.previewStoreRelease(workspaceId, app.id, body);
      if (mine !== seq) return;
      preview = done.preview;
      dialogOpen = true;
      void releaseStore.load(api, workspaceId, app.id);
    } catch (e) {
      if (mine !== seq) return;
      const failure = classifyReleaseFailure(e, 'preview', fraction);
      if (failure.kind === 'disabled') releaseStore.markDisabled(workspaceId);
      notice = { tone: failure.kind === 'disabled' ? 'warn' : 'error', title: 'No preview was made', text: failure.message };
      if (shouldReloadState(failure)) void releaseStore.load(api, workspaceId, app.id);
    } finally {
      if (mine === seq) previewing = false;
    }
  }

  function closeDialog() {
    dialogOpen = false;
    preview = null;
    dialogProblem = '';
    dialogNotice = '';
  }

  async function confirm(typed: string) {
    if (!preview || applying || preview.confirmHash === null) return;
    const sent = preview;
    const mine = ++seq;
    applying = true;
    dialogProblem = '';
    try {
      // The only call that writes to a store, and it cannot be taken back. Sent once per click, with the hash of the
      // preview and the typed phrase. This app never sends it again by itself, whatever the answer.
      const releaseBody = { ...sent.request, confirmHash: sent.confirmHash ?? '', confirmation: typed };
      const done = await confirmed((grant) => api.storeRelease(workspaceId, app.id, releaseBody, grant), releaseBody.confirmHash);
      if (mine !== seq) return;
      result = done.result;
      closeDialog();
      notice = null;
      releaseStore.markReleased(app.id);
      announcePublished(app.id);
      announcement = 'The release was started.';
      toast.success(resultText(done.result));
      void releaseStore.load(api, workspaceId, app.id);
      onreleased?.();
    } catch (e) {
      if (mine !== seq) return;
      handleFailure(classifyReleaseFailure(e, 'release', sent.request.userFraction ?? null));
    } finally {
      if (mine === seq) applying = false;
    }
  }

  function handleFailure(failure: ReleaseFailure) {
    if (shouldReloadState(failure)) void releaseStore.load(api, workspaceId, app.id);
    switch (failure.kind) {
      case 'state_changed':
        if (failure.next) {
          // Nothing was released. The new preview must be read and confirmed again.
          preview = failure.next;
          dialogNotice = failure.message;
          dialogProblem = '';
        } else {
          closeDialog();
          notice = { tone: 'warn', title: 'Things changed', text: `${failure.message} Preview again.` };
        }
        break;
      case 'outcome_unknown':
        closeDialog();
        releaseStore.markUnknown(app.id);
        notice = { tone: 'error', title: 'Not known whether it was released', text: failure.message };
        break;
      case 'other_unknown':
        closeDialog();
        notice = { tone: 'warn', title: 'Preview the earlier step first', text: failure.message };
        break;
      case 'blocked': {
        closeDialog();
        const items = failure.checks.map((c) => c.message).slice(0, 5);
        notice = { tone: 'error', title: 'Blocked, nothing was released', text: `${failure.message}${items.length > 0 ? ` ${items.join(' ')}` : ''}` };
        break;
      }
      case 'disabled':
        closeDialog();
        releaseStore.markDisabled(workspaceId);
        notice = { tone: 'warn', title: 'Switched off', text: failure.message };
        break;
      case 'forbidden':
        closeDialog();
        notice = { tone: 'error', title: 'Not allowed', text: failure.message };
        break;
      default:
        // A refusal of the store, a rate limit and the rest: shown in the dialog; nothing is sent again by itself.
        dialogProblem = mayConfirmAgain(failure) ? `${failure.message} You can confirm again.` : failure.message;
    }
  }
</script>

{#if mayAct}
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if line.kind !== 'hidden'}
    <div class="release" data-testid="release-control" role="group" aria-label="Release, {platformLabel(app.platform)}">
      {#if line.kind === 'ready'}
        {#if android && stagedFields}
          <label class="check direct-option">
            <input type="checkbox" bind:checked={direct} disabled={busy} />
            <span>Make the release from what is staged and send it to Google for review in one step (no draft needed)</span>
          </label>
        {/if}
        {#if android && !offered}
          <p class="muted small" data-testid="no-staged-rollout">{inputs.offer.message}</p>
        {:else if android}
          <div class="share">
            <label for="{uid}-share">Share of users to release to (%)</label>
            <input
              id="{uid}-share"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="For example 10"
              aria-describedby="{uid}-share-help"
              bind:value={shareText}
              disabled={busy}
            />
            <p id="{uid}-share-help" class="muted small">
              {#if fraction !== null}
                That is {percentText(fraction)} of users on {track || 'the track'}.
              {:else if shareText.trim() !== ''}
                Type a number from 0.01 to 100.
              {:else if reminder !== '' && shareText.trim() === reminder}
                You staged {reminder}%. Check that it is still right.
              {:else if shareText.trim() !== '' && shareText.trim() === lastStart}
                Starts from the default of this app. Change it if needed; you confirm the share in the phrase.
              {:else}
                You always name the share yourself. 100 is everyone.
              {/if}
            </p>
          </div>
        {/if}
        <Button
          variant="primary"
          icon="upload"
          loading={previewing}
          disabled={busy || line.disabled || needsTrack}
          title={needsTrack ? 'Choose the track in the Build step first.' : (line.reason ?? undefined)}
          onclick={startPreview}
        >{line.button}</Button>
        {#if line.disabled && line.reason}<span class="muted small">{line.reason}</span>{:else if needsTrack}<span class="muted small">Choose the track in the Build step first.</span>{/if}
      {:else if line.kind === 'off'}
        <span class="text">{line.text}</span>
        <InfoTip label="About releasing" align="end" text={line.note} />
      {:else}
        <span class="text" class:bad={line.tone === 'bad'}>{line.text}</span>
        {#if line.retry}<Button size="sm" icon="refresh" onclick={retryReads}>Try again</Button>{/if}
      {/if}
    </div>
  {/if}

  {#if notice}<Alert tone={notice.tone} title={notice.title} ondismiss={() => (notice = null)}>{notice.text}</Alert>{/if}
  {#if result}
    <Alert tone="ok" title={result.confirmedByReread ? 'Released (confirmed by reading the store back)' : 'Released'} ondismiss={() => (result = null)}>
      <p class="alert-text">{resultText(result)}</p>
    </Alert>
  {/if}
{/if}

{#if preview}
  {#key preview.confirmHash ?? `blocked-${preview.readAt}`}
    <StoreReleaseDialog
      bind:open={dialogOpen}
      {api}
      {workspaceId}
      {preview}
      busy={applying}
      problem={dialogProblem}
      notice={dialogNotice}
      onconfirm={confirm}
      oncancel={() => {
        if (!applying) {
          dialogOpen = false;
          preview = null;
        }
      }}
    />
  {/key}
{/if}

<style>
  .release {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: flex-end;
  }

  .direct-option {
    display: flex;
    flex-basis: 100%;
    gap: var(--space-2);
    align-items: flex-start;
    font-size: var(--text-sm);
  }

  .share {
    display: grid;
    gap: var(--space-1);
    min-width: 14rem;
  }

  .share label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .share input {
    max-width: 10rem;
  }

  .text {
    font-weight: var(--weight-medium);
  }

  .text.bad {
    color: var(--bad-ink);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .alert-text {
    margin: var(--space-1) 0 0;
  }
</style>
