<!--
  StagedTrayApp: the staged changes of ONE app record (one platform): the texts and the graphic sets collected
  for it, each with what the store had at the last read and what is staged, remove one or clear all, and
  "Push as draft", which opens a preview and then a confirmation. Staging and removing only change our own
  database. The push writes to the store's DRAFT only (docs/api/staged-changes.md); it never submits.
  Props: api, workspaceId, role, app, showPlatform (a platform badge in the heading, when two are in scope), part
  ('all' by default; the release stepper shows 'items' on its Review step, the list with remove and clear only, and
  'push' on its Confirm step, the count and the gated push only: both use the same code and the same dialog).
  Rules it keeps: the preview comes before every push; the push is sent once with the preview's hash; when the
  state changed meanwhile the new preview replaces the old one and must be confirmed again; an unknown outcome
  is never retried (the person previews again, which reads the store); no button submits or publishes.
-->
<script lang="ts">
  import { type Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { fileName } from '../../lib/assets/assets.ts';
  import { usage, usageText } from '../../lib/listing/drift.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type DraftPreview,
    type DraftPushResult,
    type PushFailure,
    canPush,
    canStage,
    classifyPushFailure,
    itemCount,
    mayConfirmAgain,
    problemsOf,
    pushAvailability,
    pushBlockedReason,
    pushedLabel,
    resultText,
    setTitle,
    shouldReloadStaged,
    sourceLabel,
    stagingError,
    storeName,
    textStatus,
    trayCountText,
  } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { submitStore } from '../../lib/store-submit-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StagedPushDialog from './StagedPushDialog.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    showPlatform = false,
    part = 'all',
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    showPlatform?: boolean;
    part?: 'all' | 'items' | 'push';
  } = $props();

  const showItems = $derived(part !== 'push');
  const showPush = $derived(part !== 'items');

  const uid = $props.id();

  type Notice = { tone: 'info' | 'warn' | 'error' | 'ok'; title: string; text: string };

  let loading = $state(true);
  let loadProblem = $state('');
  let problem = $state('');
  let removing = $state('');
  let confirmingClear = $state(false);
  let clearing = $state(false);
  let previewing = $state(false);
  let preview = $state<DraftPreview | null>(null);
  let dialogOpen = $state(false);
  let applying = $state(false);
  let dialogProblem = $state('');
  let dialogNotice = $state('');
  let notice = $state<Notice | null>(null);
  let result = $state<DraftPushResult | null>(null);
  /** Set after an unknown outcome: the person must preview again (a read) before pushing. */
  let unknown = $state(false);
  let announcement = $state('');
  let seq = 0;

  const view = $derived(stagedStore.view(app.id));
  const config = $derived(stagedStore.config(workspaceId));
  const availability = $derived(pushAvailability(role, config, stagedStore.configFailed(workspaceId)));
  const blocked = $derived(pushBlockedReason(view));
  const mayEdit = $derived(canStage(role));
  const pushReason = $derived(
    availability.state === 'ready' ? blocked : availability.state === 'loading' ? 'Checking whether pushing drafts is switched on.' : availability.message,
  );
  const busy = $derived(previewing || applying || clearing || removing !== '');
  const store = $derived(storeName(app.platform));

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}`;
    if (key !== shownFor) {
      shownFor = key;
      untrack(() => {
        seq++;
        problem = '';
        confirmingClear = false;
        preview = null;
        dialogOpen = false;
        notice = null;
        result = null;
        unknown = false;
        void load();
      });
    }
  });

  $effect(() => {
    void stagedStore.loadConfig(api, workspaceId);
  });

  async function load() {
    loading = stagedStore.view(app.id) === null;
    loadProblem = await stagedStore.load(api, workspaceId, app.id);
    loading = false;
  }

  async function reload() {
    // A push (or a partial or unknown one) changes whether a pushed draft waits to be submitted.
    if (canSubmit(role)) void submitStore.load(api, workspaceId, app.id);
    const message = await stagedStore.load(api, workspaceId, app.id);
    if (message !== '') loadProblem = message;
    else loadProblem = '';
  }

  async function remove(id: string, label: string) {
    if (busy) return;
    removing = id;
    problem = '';
    try {
      const done = await api.unstageItem(workspaceId, app.id, id);
      stagedStore.set(done.staged);
      announcement = `Removed ${label} from the staged changes.`;
      result = null;
    } catch (e) {
      problem = stagingError(e);
    } finally {
      removing = '';
    }
  }

  async function clearAll() {
    if (busy) return;
    clearing = true;
    problem = '';
    try {
      const done = await api.clearStaged(workspaceId, app.id);
      stagedStore.set(done.staged);
      confirmingClear = false;
      result = null;
      announcement = 'Cleared all staged changes.';
      toast.info(`Cleared the staged changes of ${platformLabel(app.platform)}.`);
    } catch (e) {
      problem = stagingError(e);
    } finally {
      clearing = false;
    }
  }

  async function startPreview() {
    if (busy || availability.state !== 'ready' || blocked !== null) return;
    const mine = ++seq;
    previewing = true;
    notice = null;
    dialogProblem = '';
    dialogNotice = '';
    try {
      // Reads the store's draft and the staged files. Not a write.
      const done = await api.previewStagedPush(workspaceId, app.id);
      if (mine !== seq) return;
      preview = done.preview;
      unknown = false;
      dialogOpen = true;
    } catch (e) {
      if (mine !== seq) return;
      const failure = classifyPushFailure(e, 'preview');
      if (failure.kind === 'disabled') stagedStore.markDisabled(workspaceId);
      notice = { tone: failure.kind === 'disabled' ? 'warn' : 'error', title: 'No preview was made', text: failure.message };
      if (shouldReloadStaged(failure)) void reload();
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

  async function confirm() {
    if (!preview || applying) return;
    const sent = preview;
    const mine = ++seq;
    applying = true;
    dialogProblem = '';
    try {
      // The only call that writes to a store. It is sent once, with the hash of the preview, and never again by this app.
      const done = await api.pushStagedDraft(workspaceId, app.id, sent.confirmHash);
      if (mine !== seq) return;
      result = done.result;
      closeDialog();
      notice = null;
      announcement = 'The staged changes were written to the store draft. Nothing was submitted.';
      void reload();
    } catch (e) {
      if (mine !== seq) return;
      handleFailure(classifyPushFailure(e, 'push'));
    } finally {
      if (mine === seq) applying = false;
    }
  }

  function handleFailure(failure: PushFailure) {
    if (shouldReloadStaged(failure)) void reload();
    switch (failure.kind) {
      case 'state_changed':
        if (failure.next) {
          // Nothing was written. The new preview must be read and confirmed again.
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
        unknown = true;
        notice = { tone: 'error', title: 'Not known whether the draft was written', text: failure.message };
        break;
      case 'partial': {
        closeDialog();
        const counts =
          failure.completed.length > 0
            ? ` ${failure.completed.length} ${failure.completed.length === 1 ? 'step' : 'steps'} reached the draft.`
            : failure.matching !== null && failure.total !== null
              ? ` ${failure.matching} of ${failure.total} items now match.`
              : '';
        const failedAt = failure.failed ? ` It stopped at ${failure.failed.target} (${failure.failed.locale}).` : '';
        notice = {
          tone: 'error',
          title: 'Only part of it reached the draft',
          text: `${failure.message}${counts}${failedAt} What was written stays in the draft. Preview and push again to finish: items that already match are skipped.`,
        };
        break;
      }
      case 'not_applied':
        closeDialog();
        notice = { tone: 'info', title: 'Nothing was changed', text: failure.message };
        break;
      case 'disabled':
        closeDialog();
        stagedStore.markDisabled(workspaceId);
        notice = { tone: 'warn', title: 'Switched off', text: failure.message };
        break;
      case 'blocked':
        closeDialog();
        notice = {
          tone: 'error',
          title: 'Nothing was pushed',
          text: `${failure.message}${failure.checks.length > 0 ? ` ${failure.checks.map((c) => c.message).slice(0, 3).join(' ')}` : ''}`,
        };
        break;
      case 'restage':
        closeDialog();
        notice = { tone: 'error', title: 'A staged file changed', text: failure.message };
        break;
      case 'invalid':
        closeDialog();
        notice = {
          tone: 'error',
          title: 'Nothing was pushed',
          text: `${failure.message}${failure.problems.length > 0 ? ` ${failure.problems.map((p) => p.message).slice(0, 3).join(' ')}` : ''}`,
        };
        break;
      case 'write_in_progress':
        dialogProblem = failure.message;
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

  const empty = $derived(itemCount(view) === 0);
  const releaseFields = $derived(view?.release ?? []);
</script>

<div class="app" data-testid="staged-app" aria-label="Staged changes, {platformLabel(app.platform)}" role="group">
  <p class="visually-hidden" role="status">{announcement}</p>

  <div class="head">
    <h4>
      {#if showPlatform}<PlatformBadge platform={app.platform} tinted />{/if}
      <span class="muted">{trayCountText(view)}</span>
      {#if view && view.totals.errors > 0}<Badge tone="bad">{view.totals.errors} {view.totals.errors === 1 ? 'error' : 'errors'}</Badge>{/if}
      {#if view && view.totals.warnings > 0}<Badge tone="warn">{view.totals.warnings} {view.totals.warnings === 1 ? 'warning' : 'warnings'}</Badge>{/if}
    </h4>
    <span class="spacer"></span>
    {#if showItems && mayEdit && !empty}
      {#if confirmingClear}
        <span class="confirm" role="group" aria-label="Clear all staged changes?">
          <span>Remove all {itemCount(view)} staged {itemCount(view) === 1 ? 'item' : 'items'}?</span>
          <Button size="sm" variant="danger" loading={clearing} disabled={busy} onclick={clearAll}>Yes, clear all</Button>
          <Button size="sm" disabled={clearing} onclick={() => (confirmingClear = false)}>Keep them</Button>
        </span>
      {:else}
        <Button size="sm" icon="trash" disabled={busy} onclick={() => (confirmingClear = true)}>Clear all</Button>
      {/if}
    {/if}
    {#if !showPush}
      <!-- the push is on another step -->
    {:else if canPush(role)}
      <Button
        size="sm"
        variant="primary"
        icon="upload"
        loading={previewing}
        disabled={busy || availability.state !== 'ready' || blocked !== null}
        title={pushReason ?? undefined}
        onclick={startPreview}
      >
        {unknown ? 'Read the draft again…' : 'Push as draft…'}
      </Button>
    {:else}
      <Button size="sm" icon="upload" disabled title={availability.state === 'role' ? availability.message : undefined}>Push as draft…</Button>
    {/if}
  </div>

  {#if !showPush}
    <!-- notes about the push are on its step -->
  {:else if !canPush(role)}
    <p class="muted note">Pushing a draft to {store} needs the admin or owner role. You can still stage changes{mayEdit ? '' : ' if your role allows it'}.</p>
  {:else if availability.state === 'off' || availability.state === 'unknown'}
    <Alert tone="warn" title={availability.state === 'off' ? 'Pushing drafts is switched off' : 'Could not check the switch'}>{availability.message}</Alert>
  {:else if blocked !== null && !empty}
    <p class="muted note">{blocked}</p>
  {/if}

  {#if loadProblem}
    <Alert tone="error" title="Could not load the staged changes">
      {loadProblem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={load}>Try again</Button></div>
    </Alert>
  {/if}
  {#if problem}<Alert tone="error" ondismiss={() => (problem = '')}>{problem}</Alert>{/if}
  {#if notice && showPush}<Alert tone={notice.tone} title={notice.title} ondismiss={() => (notice = null)}>{notice.text}</Alert>{/if}
  {#if result && showPush}
    <Alert tone="ok" title={result.confirmedByReread ? 'Written to the draft (confirmed by reading the store back)' : 'Written to the draft'} ondismiss={() => (result = null)}>
      <p class="alert-text">{resultText(result)}</p>
      {#if result.commit === 'not_sent_for_review'}
        <p class="alert-text">Google Play holds the changes back from review. Send them for review in Play Console when you are ready.</p>
      {:else if result.commit === 'draft_release'}
        <p class="alert-text">Google Play would not hold the changes back from review for this app, so the draft release was saved without that. A draft release is not served to users: roll it out in the last step or in Play Console.</p>
      {/if}
      {#if result.note}<p class="alert-text">{result.note}</p>{/if}
    </Alert>
  {/if}

  {#if !showItems}
    <!-- the items are on the Review step -->
  {:else if loading && !view}
    <div role="status" aria-label="Loading the staged changes"><Skeleton width="60%" height="16px" /></div>
  {:else if view && empty}
    <p class="muted note">
      Nothing is staged for {platformLabel(app.platform)}. The release steps on the Releases tab stage a build and the notes; on the Listing tab, a field that differs from the store has a "Stage from repo" button;
      on the Assets tab, a set of repository files has "Stage for store".
    </p>
  {:else if view}
    {#if view.text.length > 0}
      <section aria-labelledby="{uid}-texts">
        <h5 id="{uid}-texts">Texts</h5>
        <ul class="items">
          {#each view.text as t (t.id)}
            {@const status = textStatus(t)}
            {@const errors = problemsOf(t, 'error')}
            {@const warnings = problemsOf(t, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{t.label}</strong> <span class="muted">{t.locale}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Badge tone="neutral">{sourceLabel(t.source)}</Badge>
                  {#if pushedLabel(t)}<Badge tone="ok" icon="check">{pushedLabel(t)}</Badge>{/if}
                </p>
                <div class="compare">
                  <div>
                    <p class="label">In the store (last read)</p>
                    <p class="text">{#if t.before === null}<span class="muted">No value known</span>{:else}{t.before}{/if}</p>
                  </div>
                  <div>
                    <p class="label">Staged</p>
                    <p class="text">{t.value}</p>
                    <p class="meta" class:over={errors.length > 0}>{usageText(usage(t.value, t.limit, t.unit))}</p>
                  </div>
                </div>
                {#each errors as p (p.code + p.message)}<p class="problem bad">{p.message}</p>{/each}
                {#each warnings as p (p.code + p.message)}<p class="problem warn">{p.message}</p>{/each}
              </div>
              {#if mayEdit}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  loading={removing === t.id}
                  disabled={busy}
                  onclick={() => remove(t.id, `${t.label} (${t.locale})`)}
                >Remove<span class="visually-hidden"> {t.label} ({t.locale}) from the staged changes</span></Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if releaseFields.length > 0}
      <section aria-labelledby="{uid}-release">
        <h5 id="{uid}-release">Release</h5>
        <ul class="items">
          {#each releaseFields as r (r.id)}
            {@const errors = problemsOf(r, 'error')}
            {@const warnings = problemsOf(r, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{r.label}</strong>{#if r.locale} <span class="muted">{r.locale}</span>{/if}
                  <Badge tone={r.status === 'invalid' ? 'bad' : r.localOnly ? 'neutral' : 'info'}>{r.status === 'invalid' ? 'Has an error' : r.localOnly ? 'Kept here only' : 'Staged'}</Badge>
                  {#if r.pushed}<Badge tone="ok" icon="check">In the store draft</Badge>{/if}
                </p>
                <p class="text">{r.value}</p>
                {#if r.localOnly}<p class="meta">Never written to the store by a push. You name the share again when you release.</p>{/if}
                {#each errors as p (p.code + p.message)}<p class="problem bad">{p.message}</p>{/each}
                {#each warnings as p (p.code + p.message)}<p class="problem warn">{p.message}</p>{/each}
              </div>
              {#if mayEdit}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  loading={removing === r.id}
                  disabled={busy}
                  onclick={() => remove(r.id, r.label)}
                >Remove<span class="visually-hidden"> {r.label}{r.locale ? ` (${r.locale})` : ''} from the staged changes</span></Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if view.assets.length > 0}
      <section aria-labelledby="{uid}-assets">
        <h5 id="{uid}-assets">Graphics</h5>
        <ul class="items">
          {#each view.assets as s (s.id)}
            {@const errors = problemsOf(s, 'error')}
            {@const warnings = problemsOf(s, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{setTitle(s)}</strong>
                  <Badge tone={s.status === 'invalid' ? 'bad' : 'info'}>{s.status === 'invalid' ? 'Has an error' : `${s.files.length} ${s.files.length === 1 ? 'file' : 'files'}`}</Badge>
                  <Badge tone="neutral">{sourceLabel(s.source)}</Badge>
                  {#if pushedLabel(s)}<Badge tone="ok" icon="check">{pushedLabel(s)}</Badge>{/if}
                </p>
                <p class="files muted">{s.files.map((f) => fileName(f.path)).join(', ')}</p>
                {#each errors as p (p.code + p.message)}<p class="problem bad">{p.message}</p>{/each}
                {#each warnings as p (p.code + p.message)}<p class="problem warn">{p.message}</p>{/each}
              </div>
              {#if mayEdit}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  loading={removing === s.id}
                  disabled={busy}
                  onclick={() => remove(s.id, setTitle(s))}
                >Remove<span class="visually-hidden"> {setTitle(s)} from the staged changes</span></Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if preview && showPush}
  {#key preview.confirmHash}
    <StagedPushDialog
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
  .app {
    display: grid;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .head h4 {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-base);
  }

  .spacer {
    flex: 1;
  }

  .confirm {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .alert-text {
    margin: var(--space-1) 0 0;
  }

  .retry {
    margin-top: var(--space-2);
  }

  h5 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .items {
    display: grid;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .item {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .main {
    flex: 1;
    min-width: 0;
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 var(--space-2);
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .text {
    margin: 0;
    max-height: 7rem;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .meta {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .meta.over {
    color: var(--bad-ink);
  }

  .files {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .problem {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .problem.bad {
    color: var(--bad-ink);
  }

  .problem.warn {
    color: var(--warn-ink);
  }
</style>
