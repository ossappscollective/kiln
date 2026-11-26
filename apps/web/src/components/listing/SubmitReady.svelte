<!--
  SubmitReady: the slim "Draft pushed — ready to submit?" line of one app record, with the "Submit for review…"
  button and the dialog behind it. Drawn only for admin and up (`store.submit`) and only while a draft push is
  waiting to be submitted (or a submit has an unknown outcome). While the server's switch is off there is no
  button: the line says so and a small popover names KILN_STORE_SUBMIT_ENABLED.
  A submit is a SEPARATE, IRREVERSIBLE store write: the preview (a store read) comes first; the submit is sent
  once with the preview's hash and the typed phrase and is NEVER retried by this app. `state_changed` brings a
  new preview that must be confirmed again; `outcome_unknown` makes the person look at the store console and
  preview again. It never releases or publishes anything, and says so.
  Props: api, workspaceId, role, app ({ id, name, platform }), bare (only the button or the note, no text and
  no frame: for the "Needs attention" list, which draws its own line), showPlatform (a platform badge).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { announcePublished } from '../../lib/app-page.ts';
  import type { Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type SubmitFailure,
    type SubmitPreview,
    type SubmitResult,
    canSubmit,
    classifySubmitFailure,
    mayConfirmAgain,
    pushDetail,
    resultText,
    shouldReloadState,
    submitBody,
    submitLine,
  } from '../../lib/store-submit.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { submitStore } from '../../lib/store-submit-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import PublishingNote from '../publish/PublishingNote.svelte';
  import SubmitDialog from './SubmitDialog.svelte';
import { byFamily } from '@kiln/core';

  let {
    api,
    workspaceId,
    role,
    app,
    bare = false,
    showPlatform = false,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'name' | 'platform'>;
    bare?: boolean | undefined;
    showPlatform?: boolean | undefined;
  } = $props();

  type Notice = { tone: 'info' | 'warn' | 'error' | 'ok'; title: string; text: string };

  let previewing = $state(false);
  let applying = $state(false);
  let preview = $state<SubmitPreview | null>(null);
  let dialogOpen = $state(false);
  let dialogProblem = $state('');
  let dialogNotice = $state('');
  let notice = $state<Notice | null>(null);
  let result = $state<SubmitResult | null>(null);
  let announcement = $state('');
  let seq = 0;

  const mayAct = $derived(canSubmit(role));
  const line = $derived(
    submitLine({
      role,
      state: submitStore.state(app.id),
      stateFailed: submitStore.stateFailed(app.id),
      config: submitStore.config(workspaceId),
      configFailed: submitStore.configFailed(workspaceId),
    }),
  );
  const detail = $derived(pushDetail(submitStore.state(app.id)?.push ?? null, (at) => timeAgo(at)));
  const busy = $derived(previewing || applying);

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
        if (mayAct) {
          void submitStore.load(api, workspaceId, app.id);
          void submitStore.loadConfig(api, workspaceId);
        }
      });
    }
  });

  function retryReads() {
    void submitStore.load(api, workspaceId, app.id);
    void submitStore.loadConfig(api, workspaceId, true);
  }

  /** Whether the app state allows a submit now (not while a publish of the app runs, nor while its last publish failed). */
  const verdict = $derived(appStateStore.verdict(workspaceId, role, app, 'submit'));

  async function startPreview() {
    if (busy || line.kind !== 'ready' || line.disabled || !verdict.enabled) return;
    const mine = ++seq;
    previewing = true;
    notice = null;
    result = null;
    dialogProblem = '';
    dialogNotice = '';
    try {
      // Reads the store. Not a write. A successful read also settles an unknown outcome of an earlier submit.
      const done = await api.previewStoreSubmit(workspaceId, app.id);
      if (mine !== seq) return;
      preview = done.preview;
      dialogOpen = true;
      void submitStore.load(api, workspaceId, app.id);
    } catch (e) {
      if (mine !== seq) return;
      const failure = classifySubmitFailure(e, 'preview');
      if (failure.kind === 'disabled') submitStore.markDisabled(workspaceId);
      notice = { tone: failure.kind === 'disabled' ? 'warn' : 'error', title: t('listing:submitReady.noPreview'), text: failure.message };
      if (shouldReloadState(failure)) void submitStore.load(api, workspaceId, app.id);
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
    if (!preview || applying) return;
    const body = submitBody(preview, typed);
    if (body === null) return;
    const mine = ++seq;
    applying = true;
    dialogProblem = '';
    try {
      // The only call that writes to a store, and it cannot be taken back. Sent once per click, with the hash of the
      // preview and the typed phrase. This app never sends it again by itself, whatever the answer.
      const done = await confirmed((grant) => api.storeSubmit(workspaceId, app.id, body, grant), body.confirmHash);
      if (mine !== seq) return;
      result = done.result;
      closeDialog();
      notice = null;
      submitStore.markSubmitted(app.id);
      announcePublished(app.id);
      announcement = t('listing:submitReady.announce');
      toast.success(resultText(done.result));
      void submitStore.load(api, workspaceId, app.id);
    } catch (e) {
      if (mine !== seq) return;
      handleFailure(classifySubmitFailure(e, 'submit'));
    } finally {
      if (mine === seq) applying = false;
    }
  }

  function handleFailure(failure: SubmitFailure) {
    if (shouldReloadState(failure)) void submitStore.load(api, workspaceId, app.id);
    switch (failure.kind) {
      case 'state_changed':
        if (failure.next) {
          // Nothing was submitted. The new preview must be read and confirmed again.
          preview = failure.next;
          dialogNotice = failure.message;
          dialogProblem = '';
        } else {
          closeDialog();
          notice = { tone: 'warn', title: t('listing:submitReady.changedTitle'), text: t('listing:submitReady.changedText', { message: failure.message }) };
        }
        break;
      case 'outcome_unknown':
        closeDialog();
        submitStore.markUnknown(app.id);
        notice = { tone: 'error', title: t('listing:submitReady.unknownTitle'), text: failure.message };
        break;
      case 'not_applied':
        // The store did not submit it. The same preview may be confirmed again, by the person, not by this app.
        dialogProblem = failure.message;
        break;
      case 'mismatch':
      case 'write_in_progress':
        dialogProblem = failure.message;
        break;
      case 'blocked': {
        closeDialog();
        const items = failure.checks.map((c) => c.message).slice(0, 5);
        notice = { tone: 'error', title: t('listing:submitReady.blockedTitle'), text: [failure.message, ...items].join(' ') };
        break;
      }
      case 'nothing_pushed':
        closeDialog();
        notice = { tone: 'info', title: t('listing:submitReady.nothingTitle'), text: failure.message };
        break;
      case 'push_unknown':
        closeDialog();
        notice = { tone: 'warn', title: t('listing:submitReady.previewFirstTitle'), text: failure.message };
        break;
      case 'disabled':
        closeDialog();
        submitStore.markDisabled(workspaceId);
        notice = { tone: 'warn', title: t('listing:submitReady.switchedOff'), text: failure.message };
        break;
      case 'forbidden':
        closeDialog();
        notice = { tone: 'error', title: t('listing:submitReady.notAllowed'), text: failure.message };
        break;
      default:
        // A refusal of the store, a rate limit and the rest: shown in the dialog; nothing is sent again by itself.
        dialogProblem = mayConfirmAgain(failure) ? t('listing:submitReady.confirmAgain', { message: failure.message }) : failure.message;
    }
  }
</script>

{#if mayAct}
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if line.kind !== 'hidden'}
    <div class="ready" class:bare data-testid="submit-ready" role="group" aria-label={t('listing:submitReady.aria', { platform: platformLabel(app.platform) })}>
      {#if !bare}
        <span class="mark"><Icon name="upload" size={14} /></span>
        {#if showPlatform}<PlatformBadge platform={app.platform} tinted />{/if}
        <span class="text" class:bad={line.kind === 'note' && line.tone === 'bad'}>{line.text}</span>
        {#if detail && line.kind !== 'note'}<span class="muted detail">{detail}</span>{/if}
        <span class="spacer"></span>
      {:else if line.kind === 'note'}
        <span class="text muted" class:bad={line.tone === 'bad'}>{line.text}</span>
      {/if}

      {#if line.kind === 'ready'}
        <Button
          size="sm"
          variant="primary"
          icon="upload"
          loading={previewing}
          disabled={busy || line.disabled || !verdict.enabled}
          title={!verdict.enabled ? (verdict.reason ?? undefined) : (line.reason ?? undefined)}
          onclick={startPreview}
        >{line.button}</Button>
        {#if !bare}<PublishingNote {verdict} appId={app.id} />{/if}
      {:else if line.kind === 'off'}
        {#if bare}<span class="text muted">{line.text}</span>{/if}
        <InfoTip label={t('listing:submitReady.infoLabel')} align="end" text={line.note} />
      {:else if line.retry}
        <Button size="sm" icon="refresh" onclick={retryReads}>{t('common:action.tryAgain')}</Button>
      {/if}
    </div>
  {/if}

  {#if notice}<Alert tone={notice.tone} title={notice.title} ondismiss={() => (notice = null)}>{notice.text}</Alert>{/if}
  {#if result}
    <Alert tone="ok" title={t('listing:submitReady.sentTitle')} ondismiss={() => (result = null)}>
      <p class="alert-text">{resultText(result)}</p>
      {#if result.note}<p class="alert-text">{result.note}</p>{/if}
      <p class="alert-text">{t('listing:submitReady.releaseHint', { console: byFamily(result.app.platform, { apple: 'App Store Connect', google: 'Play Console' }) })}</p>
    </Alert>
  {/if}
{/if}

{#if preview}
  {#key preview.confirmHash}
    <SubmitDialog
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
        }
      }}
    />
  {/key}
{/if}

<style>
  .ready {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .ready.bare {
    padding: 0;
    background: none;
    border: 0;
  }

  .mark {
    display: inline-flex;
    color: var(--muted);
  }

  .text {
    font-weight: var(--weight-medium);
  }

  .text.bad {
    color: var(--bad-ink);
  }

  .detail {
    font-size: var(--text-xs);
  }

  .spacer {
    flex: 1;
  }

  .alert-text {
    margin: var(--space-1) 0 0;
  }
</style>
