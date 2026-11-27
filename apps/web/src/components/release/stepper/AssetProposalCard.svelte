<!--
  AssetProposalCard: "Store assets changed in the repository", at the top of the Assets step of Prepare release (docs/adr/0063-release-asset-proposal.md).
  The server compares the repository at the source of the previous release with the source of this one, runs the listing checks and the
  graphics rules on the repository side, and proposes what still differs from the store and from the cart. This card shows the findings FIRST
  (errors, then warnings, tips collapsed), then the items with a checkbox (the ones without errors are checked; one with errors can be
  selected and is confirmed in a dialog), and three buttons: Stage selected, Skip for this release, Remind me later. Nothing is staged without
  the click and nothing is sent to a store; what is staged lands in the pending changes, which the link opens.
  Props: api, workspaceId, role, app, release ({ version, track, build }: names this release for the server and for what was decided), scope.
  Hidden when there is nothing to say (no repository, nothing changed).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { type AssetProposalView, type ProposalIssue, type ProposalItem, type Role } from '@kiln/core';
  import { ApiError, type Api } from '../../../lib/api.ts';
  import { DECIDE_TIMEOUT_MS, settle, STAGE_TIMEOUT_MS } from '../../../lib/bounded-read.ts';
  import {
    cardMode,
    defaultSelection,
    idsToStage,
    issueGroups,
    issueSentence,
    itemTitle,
    localeName,
    NO_ISSUES,
    refsLine,
    resultLine,
    selectedWithErrors,
    summaryLine,
  } from '../../../lib/asset-proposal.ts';
  import { storeImagesStore } from '../../../lib/app-state/store-images-store.svelte.ts';
  import { k, t } from '../../../lib/i18n/t.ts';
  import { announceCartOpen } from '../../../lib/pending-cart.ts';
  import { announceStagedChanged } from '../../../lib/staged-sync.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { imagePairs, pairIndexOf, textDiffItems, textIndexOf } from '../../../lib/asset-proposal-diff.ts';
  import AssetProposalRow from './AssetProposalRow.svelte';
  import DiffModal from '../../ui/DiffModal.svelte';
  import ImageDiffModal from '../../ui/ImageDiffModal.svelte';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';
  import Modal from '../../ui/Modal.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    release,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string };
    release: { version: string | null; track: string | null; build: string | null };
  } = $props();

  let view = $state<AssetProposalView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let busy = $state(false);
  let selected = $state<string[]>([]);
  let confirming = $state(false);
  let note = $state<{ staged: number; left: number; failed: number } | null>(null);
  let seq = 0;
  // The comparisons (docs/adr/0067-diff-and-preview.md): store against repository, texts and images, previous and next across the list.
  let textOpen = $state(false);
  let textAt = $state(0);
  let imagesOpen = $state(false);
  let imagesAt = $state(0);
  const textItems = $derived(view ? textDiffItems(view.changes, view.platform) : []);
  const pairs = $derived(view ? imagePairs(view.changes, workspaceId, app.id) : []);
  function compare(item: ProposalItem) {
    if (item.kind === 'text') {
      textAt = textIndexOf(textItems, item.id);
      textOpen = true;
    } else {
      imagesAt = pairIndexOf(pairs, item.id);
      imagesOpen = true;
    }
  }

  const key = $derived(`${workspaceId}/${app.id}/${release.version ?? ''}/${release.track ?? ''}/${release.build ?? ''}`);
  const mode = $derived(cardMode(view));
  const groups = $derived(view ? issueGroups(view.issues) : NO_ISSUES);
  const writable = $derived(canStage(role) && view !== null && !view.locked.locked);
  const picked = $derived(view ? idsToStage(view, selected) : []);
  const withErrors = $derived(view ? selectedWithErrors(view.changes, picked) : []);

  async function load() {
    const mine = ++seq;
    loading = true;
    problem = '';
    try {
      const got = await storeImagesStore.readProposal(api, workspaceId, app.id, release, { timeoutMessage: t('release-stepper:ap.timeout') });
      if (!got.ok) throw got.error;
      const out = got.value;
      if (mine !== seq) return;
      view = out.proposal;
      selected = defaultSelection(out.proposal.changes);
    } catch (e) {
      if (mine === seq) problem = e instanceof ApiError ? stagingError(e) : t('release-stepper:ap.loadFailed');
      if (mine === seq) view = null;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  let shownFor = '';
  $effect(() => {
    const now = key;
    if (now === shownFor) return;
    shownFor = now;
    untrack(() => void load());
  });

  async function stage(acceptIssues: boolean) {
    if (!view || busy) return;
    busy = true;
    confirming = false;
    problem = '';
    try {
      const got = await settle((signal) => api.stageReleaseAssetProposal(workspaceId, app.id, { ...release, itemIds: picked, ...(acceptIssues ? { acceptIssues: true } : {}) }, signal), {
        ms: STAGE_TIMEOUT_MS,
        timeoutMessage: t('release-stepper:ap.stageTimeout'),
      });
      if (!got.ok) {
        problem = stagingError(got.error);
        // The server may have staged some of the items before the limit: read the card again so what is in the cart shows as staged.
        if (got.timedOut) {
          announceStagedChanged(app.id, 'stage');
          void load();
        }
        return;
      }
      const out = got.value;
      note = resultLine(out.results);
      if (out.proposal) {
        view = out.proposal;
        selected = defaultSelection(out.proposal.changes);
      }
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = false;
    }
  }

  const press = () => (withErrors.length > 0 ? (confirming = true) : void stage(false));

  async function decide(mode: 'skip' | 'later' | 'reopen') {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      const got = await settle((signal) => api.decideReleaseAssetProposal(workspaceId, app.id, { version: release.version, track: release.track, mode }, signal), {
        ms: DECIDE_TIMEOUT_MS,
        timeoutMessage: t('release-stepper:ap.decideTimeout'),
      });
      if (!got.ok) {
        problem = stagingError(got.error);
        return;
      }
      if (view) view = { ...view, state: got.value.state };
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = false;
    }
  }

  const toggle = (id: string) => (selected = selected.indexOf(id) === -1 ? [...selected, id] : selected.filter((x) => x !== id));
  const where = (issue: ProposalIssue): string => {
    const item = view?.changes.filter((c) => c.id === issue.itemId)[0];
    return item ? t('release-stepper:ap.issues.where', { item: itemTitle(item), locale: localeName(item.locale) }) : '';
  };
  const word = (s: ProposalIssue['severity']): string => t(s === 'error' ? k('release-stepper:ap.issues.errorWord') : s === 'warning' ? k('release-stepper:ap.issues.warningWord') : k('release-stepper:ap.issues.tipWord'));
  const notListed = $derived(view ? view.skipped.unchangedSinceRelease + view.skipped.sameAsStore + view.skipped.notStageable : 0);
</script>

{#if loading && view === null}
  <div role="status" aria-label={t('release-stepper:ap.checking')}><Skeleton width="60%" height="16px" /></div>
{:else if problem && view === null}
  <Alert tone="error" title={t('release-stepper:ap.loadFailed')}>
    {problem}
    <div class="gap"><Button size="sm" icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
  </Alert>
{:else if view && mode !== 'hidden'}
  <section class="card" aria-labelledby="ap-title" data-testid="asset-proposal">
    {#if mode === 'skipped'}
      <p class="line">
        <span>{t('release-stepper:ap.skippedLine')}</span>
        <Button variant="link" size="sm" disabled={busy} onclick={() => decide('reopen')}>{t('release-stepper:ap.show')}</Button>
      </p>
    {:else if mode === 'later'}
      <p class="line">
        <span id="ap-title">{t('release-stepper:ap.laterLine', { count: view.changes.length })}</span>
        <Button size="sm" disabled={busy} onclick={() => decide('reopen')}>{t('release-stepper:ap.review')}</Button>
      </p>
    {:else if mode === 'all_staged'}
      <Alert tone="ok" title={t('release-stepper:ap.title')}>
        <span id="ap-title" class="visually-hidden">{t('release-stepper:ap.title')}</span>
        {t('release-stepper:ap.allStaged')}
        <div class="gap"><Button size="sm" icon="layers" onclick={() => announceCartOpen(null)}>{t('release-stepper:ap.openCart')}</Button></div>
      </Alert>
    {:else}
      <header>
        <h4 id="ap-title">{t('release-stepper:ap.title')}</h4>
        <p class="muted">{t('release-stepper:ap.lead')}</p>
        <p class="line"><Badge tone="info">{summaryLine(view.summary)}</Badge></p>
        {#if refsLine(view)}<p class="muted small">{refsLine(view)}</p>{/if}
        {#if view.storeUnread}<p class="muted small">{t('release-stepper:ap.storeUnread')}</p>{/if}
        {#if view.notes.indexOf('truncated') !== -1}<p class="muted small">{t('release-stepper:ap.truncated')}</p>{/if}
      </header>

      <div class="findings" aria-labelledby="ap-issues">
        <h5 id="ap-issues">{t('release-stepper:ap.issues.title')}</h5>
        {#if groups.counts.total === 0}
          <p class="ok-line"><Badge tone="ok" icon="check">{t('release-stepper:ap.issues.none')}</Badge></p>
        {:else}
          <p class="counts">
            {#if groups.counts.errors > 0}<Badge tone="bad" icon="x-circle">{t('release-stepper:ap.issues.errors', { count: groups.counts.errors })}</Badge>{/if}
            {#if groups.counts.warnings > 0}<Badge tone="warn" icon="alert-triangle">{t('release-stepper:ap.issues.warnings', { count: groups.counts.warnings })}</Badge>{/if}
          </p>
          {#each [groups.errors, groups.warnings] as list, i (i)}
            {#if list.length > 0}
              <ul class="issues" class:errors={i === 0} class:warnings={i === 1}>
                {#each list as issue (issue.id)}
                  {@const s = issueSentence(issue, view.changes)}
                  <li>
                    <span class="word">{word(issue.severity)}</span>
                    <span class="what"><strong>{s.title}</strong> <span class="where">{where(issue)}</span><br />{s.explain}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
          {#if groups.counts.tips > 0}
            <Disclosure summary={t('release-stepper:ap.issues.tips', { count: groups.counts.tips })}>
              <ul class="issues tips">
                {#each groups.tips as issue (issue.id)}
                  {@const s = issueSentence(issue, view.changes)}
                  <li>
                    <span class="word">{word(issue.severity)}</span>
                    <span class="what"><strong>{s.title}</strong> <span class="where">{where(issue)}</span><br />{s.explain}</span>
                  </li>
                {/each}
              </ul>
            </Disclosure>
          {/if}
        {/if}
      </div>

      <div class="items" role="group" aria-labelledby="ap-items">
        <h5 id="ap-items">{t('release-stepper:ap.items.title')}</h5>
        {#if mode === 'locked'}<Alert tone="warn">{t('release-stepper:ap.locked')}</Alert>{/if}
        <ul class="rows">
          {#each view.changes as item (item.id)}
            <AssetProposalRow
              {item}
              {workspaceId}
              appId={app.id}
              selected={selected.indexOf(item.id) !== -1}
              disabled={!writable || busy}
              ontoggle={() => toggle(item.id)}
              ondiff={compare}
            />
          {/each}
        </ul>
      </div>

      {#if note}
        <div class="result" role="status">
          {#if note.staged > 0}<p>{t('release-stepper:ap.done', { count: note.staged })}</p>{/if}
          {#if note.left > 0}<p class="muted">{t('release-stepper:ap.doneLeft', { count: note.left })}</p>{/if}
          {#if note.failed > 0}<p class="bad-ink">{t('release-stepper:ap.doneFailed', { count: note.failed })}</p>{/if}
        </div>
      {/if}
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}

      <div class="actions">
        <Button variant="primary" icon="layers" loading={busy} disabled={!writable || picked.length === 0} onclick={press}>
          {t('release-stepper:ap.stage', { count: picked.length })}
        </Button>
        <Button disabled={busy || !canStage(role)} onclick={() => decide('skip')}>{t('release-stepper:ap.skip')}</Button>
        <Button variant="ghost" disabled={busy || !canStage(role)} onclick={() => decide('later')}>{t('release-stepper:ap.later')}</Button>
        {#if note && note.staged > 0}<Button variant="link" onclick={() => announceCartOpen(null)}>{t('release-stepper:ap.openCart')}</Button>{/if}
      </div>
    {/if}

    {#if mode !== 'skipped' && mode !== 'later' && view.alreadyStaged.length > 0}
      <Disclosure summary={`${t('release-stepper:ap.staged.title')} (${view.alreadyStaged.length})`}>
        <ul class="staged">
          {#each view.alreadyStaged as s (s.id)}
            <li>
              <span>{s.kind === 'text' ? itemTitle({ id: s.id, kind: 'text', locale: s.locale, field: s.field, before: null, after: '', hasErrors: false }) : s.field}</span>
              <span class="muted">{localeName(s.locale)}</span>
              <Badge tone={s.state === 'same' ? 'ok' : 'info'}>{s.state === 'same' ? t('release-stepper:ap.staged.same') : t('release-stepper:ap.staged.edited')}</Badge>
            </li>
          {/each}
        </ul>
      </Disclosure>
    {/if}
    {#if (mode === 'proposal' || mode === 'locked') && notListed > 0}
      <p class="muted small">
        {t('release-stepper:ap.notListed', { unchanged: view.skipped.unchangedSinceRelease, same: view.skipped.sameAsStore, other: view.skipped.notStageable })}
      </p>
    {/if}
  </section>

  <Modal open={confirming} title={t('release-stepper:ap.confirm.title')} size="sm" onclose={() => (confirming = false)}>
    <p>{t('release-stepper:ap.confirm.body', { count: withErrors.length })}</p>
    {#snippet footer()}
      <Button onclick={() => (confirming = false)}>{t('common:action.cancel')}</Button>
      <Button variant="primary" loading={busy} onclick={() => stage(true)}>{t('release-stepper:ap.confirm.yes')}</Button>
    {/snippet}
  </Modal>
  <DiffModal bind:open={textOpen} bind:index={textAt} items={textItems} beforeLabel={t('common:diff.store')} afterLabel={t('common:diff.repository')} />
  <ImageDiffModal bind:open={imagesOpen} bind:index={imagesAt} {pairs} beforeLabel={t('common:diff.store')} afterLabel={t('common:diff.repository')} />
{/if}

<style>
  .card {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
  }
  h4,
  h5,
  p {
    margin: 0;
  }
  h5 {
    font-size: var(--text-sm);
  }
  .small {
    font-size: var(--text-sm);
  }
  .line,
  .counts,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .gap {
    margin-top: var(--space-2);
  }
  .issues,
  .rows,
  .staged {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .issues li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .issues.errors li {
    background: var(--bad-bg);
    border-color: var(--bad-line);
    color: var(--bad-ink);
  }
  .issues.warnings li {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn-ink);
  }
  .word {
    font-weight: 600;
    white-space: nowrap;
  }
  .where {
    opacity: 0.85;
  }
  .staged li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .result p {
    margin: 0;
  }
  .bad-ink {
    color: var(--bad-ink);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
