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
  import { type Role, platformMeta, stagedCountsOf } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { fileName } from '../../lib/assets/assets.ts';
  import { t } from '../../lib/i18n/t.ts';
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
    textStatus,
    trayCountText,
  } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { reportShown } from '../../lib/app-state/dev-assert.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { submitStore } from '../../lib/store-submit-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import PublishingNote from '../publish/PublishingNote.svelte';
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
    showPlatform?: boolean | undefined;
    part?: 'all' | 'items' | 'push' | undefined;
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
    availability.state === 'ready' ? blocked : availability.state === 'loading' ? t('listing:trayApp.checkingSwitch') : availability.message,
  );
  /** Whether the app state allows pushing these items now: while a batch publish writes them they cannot be pushed again or removed. */
  const verdict = $derived(appStateStore.verdict(workspaceId, role, app, 'push'));
  const busy = $derived(previewing || applying || clearing || removing !== '' || !verdict.enabled);
  const store = $derived(platformMeta(app.platform).storeName);

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
      announcement = t('listing:trayApp.removed', { label });
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
      announcement = t('listing:trayApp.cleared');
      toast.info(t('listing:trayApp.clearedToast', { platform: platformLabel(app.platform) }));
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
      notice = { tone: failure.kind === 'disabled' ? 'warn' : 'error', title: t('listing:trayApp.noPreview'), text: failure.message };
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
      announcement = t('listing:trayApp.written');
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
          notice = { tone: 'warn', title: t('listing:trayApp.changedTitle'), text: t('listing:trayApp.changedText', { message: failure.message }) };
        }
        break;
      case 'outcome_unknown':
        closeDialog();
        unknown = true;
        notice = { tone: 'error', title: t('listing:trayApp.unknownTitle'), text: failure.message };
        break;
      case 'partial': {
        closeDialog();
        const parts: string[] = [failure.message];
        if (failure.completed.length > 0)
          parts.push(t('listing:trayApp.partial.steps', { count: failure.completed.length }));
        else if (failure.matching !== null && failure.total !== null)
          parts.push(t('listing:trayApp.partial.match', { matching: failure.matching, count: failure.total }));
        if (failure.failed)
          parts.push(t('listing:trayApp.partial.stoppedAt', { target: failure.failed.target, locale: failure.failed.locale }));
        parts.push(t('listing:trayApp.partial.closing'));
        notice = { tone: 'error', title: t('listing:trayApp.partial.title'), text: parts.join(' ') };
        break;
      }
      case 'not_applied':
        closeDialog();
        notice = { tone: 'info', title: t('listing:trayApp.notChanged'), text: failure.message };
        break;
      case 'disabled':
        closeDialog();
        stagedStore.markDisabled(workspaceId);
        notice = { tone: 'warn', title: t('listing:trayApp.switchedOff'), text: failure.message };
        break;
      case 'blocked':
        closeDialog();
        notice = {
          tone: 'error',
          title: t('listing:trayApp.nothingPushed'),
          text: [failure.message, ...failure.checks.map((c) => c.message).slice(0, 3)].join(' '),
        };
        break;
      case 'restage':
        closeDialog();
        notice = { tone: 'error', title: t('listing:trayApp.fileChanged'), text: failure.message };
        break;
      case 'invalid':
        closeDialog();
        notice = {
          tone: 'error',
          title: t('listing:trayApp.nothingPushed'),
          text: [failure.message, ...failure.problems.map((p) => p.message).slice(0, 3)].join(' '),
        };
        break;
      case 'write_in_progress':
        dialogProblem = failure.message;
        break;
      case 'forbidden':
        closeDialog();
        notice = { tone: 'error', title: t('listing:trayApp.notAllowed'), text: failure.message };
        break;
      default:
        // A refusal of the store, a rate limit and the rest: shown in the dialog; nothing is sent again by itself.
        dialogProblem = mayConfirmAgain(failure) ? t('listing:trayApp.confirmAgain', { message: failure.message }) : failure.message;
    }
  }

  const empty = $derived(itemCount(view) === 0);
  /** The graphic sets the tray lists (pushed ones included: they stay staged until they are discarded). */
  const graphicSets = $derived(stagedCountsOf(view).totalSets);
  // Dev monitor: the graphic sets the tray's text says a push would send.
  $effect(() => {
    const toPush = stagedCountsOf(view).unpushedSets;
    if (toPush > 0) reportShown('stagedAssetSets', toPush, 'stagedTray');
  });
  const releaseFields = $derived(view?.release ?? []);
</script>

<div class="app" data-testid="staged-app" aria-label={t('listing:trayApp.aria', { platform: platformLabel(app.platform) })} role="group">
  <p class="visually-hidden" role="status">{announcement}</p>

  <div class="head">
    <h4>
      {#if showPlatform}<PlatformBadge platform={app.platform} tinted />{/if}
      <span class="muted">{trayCountText(view)}</span>
      {#if view && view.totals.errors > 0}<Badge tone="bad">{t('listing:trayApp.errors', { count: view.totals.errors })}</Badge>{/if}
      {#if view && view.totals.warnings > 0}<Badge tone="warn">{t('listing:trayApp.warnings', { count: view.totals.warnings })}</Badge>{/if}
    </h4>
    <span class="spacer"></span>
    {#if showItems && mayEdit && !empty}
      {#if confirmingClear}
        <span class="confirm" role="group" aria-label={t('listing:trayApp.clearAria')}>
          <span>{t('listing:trayApp.removeAll', { count: itemCount(view) })}</span>
          <Button size="sm" variant="danger" loading={clearing} disabled={busy} onclick={clearAll}>{t('listing:trayApp.yesClear')}</Button>
          <Button size="sm" disabled={clearing} onclick={() => (confirmingClear = false)}>{t('listing:trayApp.keepThem')}</Button>
        </span>
      {:else}
        <Button size="sm" icon="trash" disabled={busy} onclick={() => (confirmingClear = true)}>{t('listing:trayApp.clearAll')}</Button>
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
        title={!verdict.enabled ? (verdict.reason ?? undefined) : (pushReason ?? undefined)}
        onclick={startPreview}
      >
        {unknown ? t('listing:trayApp.readDraftAgain') : t('listing:trayApp.pushAsDraft')}
      </Button>
    {:else}
      <Button size="sm" icon="upload" disabled title={availability.state === 'role' ? availability.message : undefined}>{t('listing:trayApp.pushAsDraft')}</Button>
    {/if}
  </div>

  <PublishingNote {verdict} appId={app.id} />

  {#if !showPush}
    <!-- notes about the push are on its step -->
  {:else if !canPush(role)}
    <p class="muted note">{mayEdit ? t('listing:trayApp.roleNote', { store }) : t('listing:trayApp.roleNoteViewer', { store })}</p>
  {:else if availability.state === 'off' || availability.state === 'unknown'}
    <Alert tone="warn" title={availability.state === 'off' ? t('listing:trayApp.offTitle') : t('listing:trayApp.unknownSwitchTitle')}>{availability.message}</Alert>
  {:else if blocked !== null && !empty}
    <p class="muted note">{blocked}</p>
  {/if}

  {#if loadProblem}
    <Alert tone="error" title={t('listing:trayApp.loadFailed')}>
      {loadProblem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </Alert>
  {/if}
  {#if problem}<Alert tone="error" ondismiss={() => (problem = '')}>{problem}</Alert>{/if}
  {#if notice && showPush}<Alert tone={notice.tone} title={notice.title} ondismiss={() => (notice = null)}>{notice.text}</Alert>{/if}
  {#if result && showPush}
    <Alert tone="ok" title={result.confirmedByReread ? t('listing:trayApp.writtenConfirmed') : t('listing:trayApp.writtenTitle')} ondismiss={() => (result = null)}>
      <p class="alert-text">{resultText(result)}</p>
      {#if result.commit === 'not_sent_for_review'}
        <p class="alert-text">{t('listing:trayApp.playHeld')}</p>
      {:else if result.commit === 'draft_release'}
        <p class="alert-text">{t('listing:trayApp.playDraftRelease')}</p>
      {/if}
      {#if result.note}<p class="alert-text">{result.note}</p>{/if}
    </Alert>
  {/if}

  {#if !showItems}
    <!-- the items are on the Review step -->
  {:else if loading && !view}
    <div role="status" aria-label={t('listing:trayApp.loadingAria')}><Skeleton width="60%" height="16px" /></div>
  {:else if view && empty}
    <p class="muted note">{t('listing:trayApp.empty', { platform: platformLabel(app.platform) })}</p>
  {:else if view}
    {#if view.text.length > 0}
      <section aria-labelledby="{uid}-texts">
        <h5 id="{uid}-texts">{t('listing:trayApp.texts')}</h5>
        <ul class="items">
          {#each view.text as txt (txt.id)}
            {@const status = textStatus(txt)}
            {@const errors = problemsOf(txt, 'error')}
            {@const warnings = problemsOf(txt, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{txt.label}</strong> <span class="muted">{txt.locale}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Badge tone="neutral">{sourceLabel(txt.source)}</Badge>
                  {#if pushedLabel(txt)}<Badge tone="ok" icon="check">{pushedLabel(txt)}</Badge>{/if}
                </p>
                <div class="compare">
                  <div>
                    <p class="label">{t('listing:trayApp.inStoreLastRead')}</p>
                    <p class="text">{#if txt.before === null}<span class="muted">{t('listing:trayApp.noValueKnown')}</span>{:else}{txt.before}{/if}</p>
                  </div>
                  <div>
                    <p class="label">{t('listing:trayApp.staged')}</p>
                    <p class="text">{txt.value}</p>
                    <p class="meta" class:over={errors.length > 0}>{usageText(usage(txt.value, txt.limit, txt.unit))}</p>
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
                  loading={removing === txt.id}
                  disabled={busy}
                  aria-label={t('listing:trayApp.removeItem', { label: t('listing:trayApp.itemWithLocale', { label: txt.label, locale: txt.locale }) })}
                  onclick={() => remove(txt.id, t('listing:trayApp.itemWithLocale', { label: txt.label, locale: txt.locale }))}
                >{t('listing:trayApp.remove')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if releaseFields.length > 0}
      <section aria-labelledby="{uid}-release">
        <h5 id="{uid}-release">{t('listing:trayApp.release')}</h5>
        <ul class="items">
          {#each releaseFields as r (r.id)}
            {@const errors = problemsOf(r, 'error')}
            {@const warnings = problemsOf(r, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{r.label}</strong>{#if r.locale} <span class="muted">{r.locale}</span>{/if}
                  <Badge tone={r.status === 'invalid' ? 'bad' : r.localOnly ? 'neutral' : 'info'}>{r.status === 'invalid' ? t('publish:staged.status.error') : r.localOnly ? t('publish:staged.preview.keptHere') : t('listing:trayApp.staged')}</Badge>
                  {#if r.pushed}<Badge tone="ok" icon="check">{t('publish:staged.inStoreDraft')}</Badge>{/if}
                </p>
                <p class="text">{r.value}</p>
                {#if r.localOnly}<p class="meta">{t('listing:trayApp.neverWritten')}</p>{/if}
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
                  aria-label={t('listing:trayApp.removeItem', { label: r.locale ? t('listing:trayApp.itemWithLocale', { label: r.label, locale: r.locale }) : r.label })}
                  onclick={() => remove(r.id, r.label)}
                >{t('listing:trayApp.remove')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if graphicSets > 0}
      <section aria-labelledby="{uid}-assets">
        <h5 id="{uid}-assets">{t('listing:trayApp.graphics')}</h5>
        <ul class="items">
          {#each view.assets as s (s.id)}
            {@const errors = problemsOf(s, 'error')}
            {@const warnings = problemsOf(s, 'warning')}
            <li class="item">
              <div class="main">
                <p class="name">
                  <strong>{setTitle(s)}</strong>
                  <Badge tone={s.status === 'invalid' ? 'bad' : 'info'}>{s.status === 'invalid' ? t('publish:staged.status.error') : t('publish:staged.count.files', { count: s.files.length })}</Badge>
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
                  aria-label={t('listing:trayApp.removeItem', { label: setTitle(s) })}
                  onclick={() => remove(s.id, setTitle(s))}
                >{t('listing:trayApp.remove')}</Button>
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
