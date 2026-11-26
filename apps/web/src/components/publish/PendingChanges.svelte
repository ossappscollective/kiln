<!--
  PendingChanges: everything an app has pending, in ONE place (the "Pending changes" section of the app, and the Review and Confirm
  steps of the release stepper). Per platform in scope: the items by kind (listing text, screenshots and graphics, release fields,
  drafts pushed and not yet submitted, approved and waiting for release, rollout, and what is in review, which is information only),
  each with its state, its problems (an error blocks the step it waits for and is shown in red), what happens next, a link to change
  it and, for staged items, a discard (our own database only: the same calls as the staged tray). At the top, "Review and publish all"
  opens the plan dialog; it is disabled with the reason (role, the server's switch and how to turn it on, nothing waiting); with errors it stays enabled and lists what blocks, each with "Show it" (the server plans per step, so a blocked item cannot be left out and nothing is published). The page title comes from the app header, so no heading is drawn here.
  Every row has an expand chevron (collapsed by default, `PendingItemPreview`: the cart's shared preview for staged items, facts for the others) and each platform group "Show all previews" / "Hide all previews"; a graphics row shows its first thumbnails inline.
  Reads stored state only: no store is contacted until the person opens the plan.
  Props: api, workspaceId, role, members (the app records in scope), 
  compact? (the stepper: no hint line), list? (false: only the line and the button, no items; the stepper's last step), headless?
  (the stepper's last step: no line and no button of its own, the stepper's footer holds "Review and publish" and calls `open()`; `publishState()`
  says whether it can be pressed and why not; a blocking error still shows here), onpublished? (called after the screens read again following a
  publish or a discard, so a parent can refresh what it shows).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick, untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type Expanded, PREVIEW_KEYS, expansionOf, noneExpanded, pruneExpanded, toggleAll, toggleExpanded } from '../../lib/cart-preview.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    type BlockingItem,
    type PendingItem,
    type PendingView,
    blockingItems,
    combineTotals,
    discardIds,
    editHref,
    errorsOf,
    groupItems,
    isDiscardable,
    itemAnchor,
    nextStepText,
    platformGroups,
    publishAvailability,
    pushAndSubmitSteps,
    replaceReviewSteps,
    type StepRequest,
    stateBadge,
    totalsLine,
    warningsOf,
  } from '../../lib/pending.ts';
  import { type CartRow, toRows } from '../../lib/pending-cart.ts';
  import { itemKey, needsCart, thumbsOf } from '../../lib/pending-preview.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { canStage, stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import CartGraphicsDetail from '../app/CartGraphicsDetail.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Section from '../ui/Section.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import T from '../ui/T.svelte';
  import PublishDialog from '../publish/PublishDialog.svelte';
  import FailureAnchor from '../app-state/FailureAnchor.svelte';
  import PublishFailure from './PublishFailure.svelte';
  import PublishingStatus from './PublishingStatus.svelte';
  import PendingItemPreview from './PendingItemPreview.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    compact = false,
    list = true,
    headless = false,
    onpublished,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    compact?: boolean | undefined;
    list?: boolean | undefined;
    headless?: boolean | undefined;
    onpublished?: (() => void) | undefined;
  } = $props();

  const uid = $props.id();

  let loading = $state(true);
  let loadProblem = $state('');
  let problem = $state('');
  /** The key of what is being removed, and of what waits for "Yes, remove". */
  let removing = $state('');
  let confirming = $state('');
  let publishOpen = $state(false);
  let dialogTargets = $state<AppSummary[]>([]);
  /** The steps the dialog plans for: null is the default plan; the push and submit in one step when the person chose it after a refused draft. */
  let dialogSteps = $state<StepRequest[] | null>(null);
  /** After pressing the button while errors block it: the list of what blocks. */
  let showBlockers = $state(false);
  let blockedEl = $state<HTMLElement | null>(null);
  let announcement = $state('');
  let now = $state(Date.now());
  let seq = 0;
  /** The rows whose preview is open (collapsed by default), and the app's cart rows the staged items are previewed through (read lazily, stored state only). */
  let expanded = $state<Expanded>(noneExpanded);
  let carts = $state<Record<string, CartRow[] | 'failed'>>({});

  const ids = $derived(members.map((m) => m.id));
  const views = $derived(members.map((m): PendingView | null => pendingStore.view(m.id)));
  const known = $derived(views.every((v) => v !== null));
  const groups = $derived(platformGroups(views));
  const totals = $derived(combineTotals(groups.map((g) => g.platform)));
  const nextSteps = $derived(
    views.reduce<PendingView['totals']['nextSteps']>((all, v) => {
      for (const s of v?.totals.nextSteps ?? []) if (all.indexOf(s) < 0) all.push(s);
      return all;
    }, []),
  );
  const empty = $derived(known && totals.items === 0);
  /** The state of the app (the one model every surface reads): what is publishing, what failed, and what may be done now. */
  const appState = $derived(appStateStore.of({ workspaceId, role, records: members, scope: 'both' }));
  /** The records of this app whose publish runs now (polled while one runs). While it runs their items are being written. */
  const publishing = $derived(appState.publishing);
  const publishingOf = (appId: string) => publishing.find((p) => p.appId === appId)?.entry ?? null;
  const publishVerdict = $derived(appState.canDo('publish'));
  const publishHeld = $derived(publishVerdict.code === 'publishing');
  /** Why the buttons that would race a running publish are off. */
  const publishingReason = $derived(publishHeld ? (publishVerdict.reason ?? '') : '');
  /** A publish of one of these records that did not go through and ended: one line, until dismissed or a new publish starts. */
  const lastFailures = $derived(appState.failures);
  /** Whether the records hold back what removes or rewrites their items (a publish of the app runs). */
  const held = (appId: string): boolean => {
    const member = members.find((m) => m.id === appId);
    return member !== undefined && appState.canDo('discard', member.platform).code === 'publishing';
  };
  // Each step that starts or ends changes what is pending (the pushed items become "pushed"): read the views again, once per change.
  let stepKey = '';
  $effect(() => {
    const key = publishing.map((p) => `${p.appId}:${p.entry.currentStep ?? ''}:${p.entry.stepStartedAt ?? ''}`).join('|');
    if (key === stepKey) return;
    const first = stepKey === '';
    stepKey = key;
    if (!first && key !== '') untrack(() => void Promise.all(ids.map((id) => pendingStore.loadView(api, workspaceId, id))).then(() => (now = Date.now())));
  });
  const availability = $derived(
    publishAvailability({
      role,
      config: pendingStore.config(workspaceId),
      configFailed: pendingStore.configFailed(workspaceId),
      totals: known ? totals : null,
      nextSteps,
    }),
  );
  const blockers = $derived<BlockingItem[]>(blockingItems(groups));
  const mayEdit = $derived(canStage(role));
  const busy = $derived(removing !== '');
  const targets = $derived(
    groups
      .filter((g) => g.platform.totals.actionable > 0)
      .map((g) => members.find((m) => m.id === g.appId))
      .filter((m): m is AppSummary => m !== undefined),
  );
  const emptyPlatforms = $derived(members.length > 1 && !empty ? members.filter((m) => !groups.some((g) => g.appId === m.id)).map((m) => platformLabel(m.platform)) : []);
  const lastSynced = $derived(views.reduce<number | null>((at, v) => (v?.lastSyncedAt != null && (at === null || v.lastSyncedAt < at) ? v.lastSyncedAt : at), null));

  /** Short words for the one line that says why the button cannot be pressed (the full reason is under it). */
  const pillLabel = $derived(
    availability.state === 'role'
      ? t('publish:pending.pill.role')
      : availability.state === 'off'
        ? t('publish:pending.pill.off')
        : availability.state === 'steps_off'
          ? t('publish:pending.pill.stepsOff')
          : availability.state === 'unknown'
            ? t('publish:pending.pill.unknown')
            : '',
  );

  const cartRowsOf = (appId: string): CartRow[] | null => {
    const c = carts[appId];
    return Array.isArray(c) ? c : null;
  };
  async function loadCart(appId: string) {
    try {
      carts[appId] = toRows(appId, (await api.appPendingCart(workspaceId, appId)).cart.items);
    } catch {
      carts[appId] = 'failed';
    }
  }
  /** The cart rows give the thumbnails of a collapsed graphics row and the ids and versions of every staged preview: read again whenever the view is. */
  let cartsFor = '';
  $effect(() => {
    const wanted = list ? groups.filter((g) => g.platform.items.some(needsCart)).map((g) => g.appId) : [];
    const key = `${workspaceId}|${views.map((v) => v?.generatedAt ?? 0).join(',')}|${wanted.join(',')}`;
    if (key === cartsFor) return;
    cartsFor = key;
    untrack(() => {
      for (const id of wanted) void loadCart(id);
    });
  });
  const everyRow = $derived(groups.flatMap((g) => g.platform.items.map((i) => ({ key: itemKey(g.appId, i) }))));
  $effect(() => {
    const kept = pruneExpanded(untrack(() => expanded), everyRow);
    if (kept !== untrack(() => expanded)) expanded = kept;
  });

  async function load() {
    const mine = ++seq;
    loading = ids.some((id) => pendingStore.view(id) === null);
    loadProblem = '';
    const wanted = ids.slice();
    const reads = wanted.map((id) => pendingStore.loadView(api, workspaceId, id));
    if (can(role, 'store.publish')) void pendingStore.loadConfig(api, workspaceId);
    const messages = await Promise.all(reads);
    if (mine !== seq) return;
    loadProblem = messages.filter((m) => m !== '')[0] ?? '';
    loading = false;
    now = Date.now();
  }

  /** The banner and the chips read the summary; when it is newer than this detail and says something else, read the detail again. */
  let healedFor = '';
  $effect(() => {
    const stale = appStateStore.staleViews(workspaceId, ids);
    if (stale === null || loading) return;
    if (stale.key === healedFor) return;
    healedFor = stale.key;
    untrack(() => void Promise.all(stale.ids.map((id) => pendingStore.loadView(api, workspaceId, id))));
  });

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${ids.join(',')}`;
    if (key === shownFor) return;
    shownFor = key;
    untrack(() => {
      problem = '';
      confirming = '';
      void load();
    });
  });

  async function changed() {
    await pendingStore.refresh(api, workspaceId, ids, { submit: canSubmit(role) });
    now = Date.now();
    onpublished?.();
  }

  async function discard(appId: string, item: PendingItem) {
    if (busy || held(appId)) return;
    const key = `${appId}/${item.id}`;
    removing = key;
    problem = '';
    try {
      for (const id of discardIds(item)) {
        const done = await api.unstageItem(workspaceId, appId, id);
        stagedStore.set(done.staged);
      }
      announcement = t('publish:pending.removed', { label: item.label });
      confirming = '';
    } catch (e) {
      problem = stagingError(e);
    } finally {
      removing = '';
      await changed();
    }
  }

  async function clearAll(appId: string, platform: string) {
    if (busy || held(appId)) return;
    removing = `clear/${appId}`;
    problem = '';
    try {
      const done = await api.clearStaged(workspaceId, appId);
      stagedStore.set(done.staged);
      confirming = '';
      announcement = t('publish:pending.cleared');
      toast.info(t('publish:pending.clearedToast', { platform }));
    } catch (e) {
      problem = stagingError(e);
    } finally {
      removing = '';
      await changed();
    }
  }

  const stagedCount = (items: readonly PendingItem[]): number =>
    items.filter((i) => i.kind === 'listing_text' || i.kind === 'asset_set' || i.kind === 'release_field').reduce((n, i) => n + (i.kind === 'listing_text' ? (i.counts.changes ?? i.refs.length) : 1), 0);

  function openPublish() {
    if (publishHeld) return;
    if (availability.state === 'blocked') {
      // The server plans per step, so an item with an error cannot be left out: show what blocks, offer no publish.
      showBlockers = true;
      void tick().then(() => blockedEl?.focus());
      return;
    }
    if (availability.state !== 'ready' || targets.length === 0) return;
    // Kept as they were when the dialog opened: while it publishes the views are read again (each step changes them), and a dialog whose
    // targets vanish with the last step would be gone before it showed what happened.
    dialogTargets = targets;
    dialogSteps = null;
    publishOpen = true;
  }

  /**
   * Google Play had changes in review and refused another: "Replace the review in progress with everything together" opens the plan with
   * that push and the release for the app. Nothing is sent from here: the plan asks for the confirmation and the step-up.
   */
  function reopenAsReplace(appId: string) {
    const member = members.find((m) => m.id === appId);
    if (!member || publishHeld) return;
    if (availability.state === 'blocked') {
      openPublish();
      return;
    }
    if (availability.state !== 'ready') return;
    dialogTargets = [member];
    // The plan replaces the review in progress with everything together; the person still confirms it (the phrase or the step-up).
    dialogSteps = replaceReviewSteps();
    publishOpen = true;
  }

  /**
   * Google Play would not keep this app's changes as a draft: "Push and submit for review in one step" opens the plan with that one
   * step for the app. Nothing is sent from here: the plan still asks for the confirmation of a step that cannot be undone, and the step-up.
   */
  function reopenAsPushSubmit(appId: string) {
    const member = members.find((m) => m.id === appId);
    if (!member || publishHeld) return;
    if (availability.state === 'blocked') {
      openPublish();
      return;
    }
    if (availability.state !== 'ready') return;
    dialogTargets = [member];
    dialogSteps = pushAndSubmitSteps();
    publishOpen = true;
  }

  /** For a parent that holds the button (the stepper's footer): open the plan, or show what blocks it. */
  export function open() {
    openPublish();
  }

  /** Whether the button can be pressed, and the one line that says why it cannot (empty when it can). */
  export function publishState(): { enabled: boolean; reason: string } {
    const enabled = (availability.state === 'ready' || availability.state === 'blocked') && targets.length > 0 && !publishHeld;
    if (enabled) return { enabled, reason: '' };
    if (publishHeld) return { enabled, reason: publishingReason };
    if (loading && !known) return { enabled, reason: t('publish:pending.stateReading') };
    return { enabled, reason: pillLabel !== '' ? pillLabel : availability.state === 'ready' ? t('publish:pending.stateNothing') : availability.message };
  }

  /** "Show it": scrolls to the item and puts the focus on its row. */
  function showItem(anchor: string) {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }
</script>

<section class="pending" aria-label={t('publish:pending.aria')} data-testid="pending-changes">
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if !headless}
  <div class="top">
    <div class="lead">
      <p class="line" class:muted={empty || loading}>
        {#if loading && !known}{t('publish:pending.reading')}{:else if loadProblem && !known}{t('publish:pending.readFailed')}{:else}{empty ? t('publish:pending.nothing') : totalsLine(totals)}{/if}
      </p>
      {#if !compact && !empty && known}
        <p class="muted small">{t('publish:pending.hint')}</p>
      {/if}
    </div>
    <div class="act">
      <SectionsToggle />
      <Button
        variant="primary"
        size="lg"
        icon="upload"
        disabled={(availability.state !== 'ready' && availability.state !== 'blocked') || targets.length === 0 || publishHeld}
        title={publishHeld ? publishingReason : undefined}
        aria-describedby={availability.state !== 'ready' ? `${uid}-why` : undefined}
        onclick={openPublish}
      >{t('publish:pending.reviewAll')}</Button>
    </div>
  </div>
  {/if}

  {#if empty}
    <!-- quiet: nothing is pending, so nothing needs explaining -->
  {:else if availability.state === 'blocked'}
    <div class="blocked-box" id="{uid}-why" tabindex="-1" bind:this={blockedEl}>
      <p class="blocked"><Icon name="alert-triangle" size={14} /> {availability.message}</p>
      {#if showBlockers}
        <ul class="blockers" data-testid="pending-blockers">
          {#each blockers as b (b.anchor)}
            <li>
              <span><T key="publish:pending.blockerLine" params={{ label: b.label, platform: platformLabel(b.platform), messages: b.messages.join(' ') }} /></span>
              <Button size="sm" variant="ghost" aria-label={t('publish:pending.showItFor', { label: b.label })} onclick={() => showItem(b.anchor)}>{t('publish:pending.showIt')}</Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if headless}
    <!-- the footer of the stepper says why the button is off -->
  {:else if availability.state === 'nothing' || availability.state === 'loading'}
    {#if !empty && known}<p class="muted small" id="{uid}-why">{availability.message}</p>{/if}
  {:else if availability.state !== 'ready' && pillLabel !== ''}
    <div id="{uid}-why">
      <StatusPill tone="info" label={pillLabel} stateKey="pending-publish-{availability.state}">
        <p class="small">{availability.message}</p>
      </StatusPill>
    </div>
  {/if}

  {#each publishing.filter((p) => !groups.some((g) => g.appId === p.appId)) as p (p.appId)}
    <PublishingStatus publishing={p.entry} platform={p.platform} appId={p.appId} />
  {/each}
  {#each lastFailures as f (f.appId)}
    <FailureAnchor appId={f.appId}>
      <PublishFailure run={f.run} appName={f.name} platform={f.platform} ondismiss={() => appStateStore.dismissFailure(api, workspaceId, f.appId)} onpushsubmit={() => reopenAsPushSubmit(f.appId)} onreplace={() => reopenAsReplace(f.appId)} />
    </FailureAnchor>
  {/each}

  {#if loadProblem}
    <Alert tone="error" title={t('publish:pending.loadFailedTitle')}>
      {loadProblem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </Alert>
  {/if}
  {#if problem}<Alert tone="error" ondismiss={() => (problem = '')}>{problem}</Alert>{/if}

  {#if !list}
    <!-- only the line and the button are wanted here -->
  {:else if loading && !known}
    <div role="status" aria-label={t('publish:pending.loadingAria')} class="stack">
      <Skeleton width="60%" height="16px" />
      <Skeleton width="80%" height="48px" />
    </div>
  {:else if empty}
    <p class="empty muted"><Icon name="check-circle" size={16} /> {t('publish:pending.empty')}</p>
  {:else}
    {#each groups as g (g.appId + g.platform.platform)}
      {@const app = members.find((m) => m.id === g.appId)}
      {@const count = stagedCount(g.platform.items)}
      {@const rows = g.platform.items.map((i) => ({ key: itemKey(g.appId, i) }))}
      {@const allOpen = expansionOf(expanded, rows) === 'all'}
      {@const running = publishingOf(g.appId)}
      <section class="group card" class:publishing={running !== null} aria-label={t('publish:pending.groupAria', { platform: platformLabel(g.platform.platform) })}>
        {#if running}<PublishingStatus publishing={running} platform={g.platform.platform} appId={g.appId} />{/if}
        <div class="group-head">
          {#if members.length > 1 || groups.length > 1}<PlatformBadge platform={g.platform.platform} tinted />{/if}
          <span class="muted">{totalsLine(g.platform.totals)}</span>
          <span class="spacer"></span>
          <Button
            size="sm"
            variant="ghost"
            icon={allOpen ? 'chevron-up' : 'chevron-down'}
            aria-label={allOpen ? t('publish:pending.preview.hideAllFor', { platform: platformLabel(g.platform.platform) }) : t('publish:pending.preview.showAllFor', { platform: platformLabel(g.platform.platform) })}
            onclick={() => (expanded = toggleAll(expanded, rows))}
          >{allOpen ? t('publish:pending.preview.hideAll') : t('publish:pending.preview.showAll')}</Button>
          {#if mayEdit && count > 0 && app}
            {#if confirming === `clear/${g.appId}`}
              <span class="confirm" role="group" aria-label={t('publish:pending.clearAria')}>
                <span>{t('publish:pending.removeAll', { count })}</span>
                <Button size="sm" variant="danger" loading={removing === `clear/${g.appId}`} disabled={busy} onclick={() => clearAll(g.appId, platformLabel(g.platform.platform))}>{t('publish:pending.yesClear')}</Button>
                <Button size="sm" disabled={busy} onclick={() => (confirming = '')}>{t('publish:pending.keepThem')}</Button>
              </span>
            {:else}
              <Button size="sm" icon="trash" disabled={busy || held(g.appId)} title={held(g.appId) ? publishingReason : undefined} aria-label={t('publish:pending.discardAllFor', { platform: platformLabel(g.platform.platform) })} onclick={() => (confirming = `clear/${g.appId}`)}>{t('publish:pending.discardAll')}</Button>
            {/if}
          {/if}
        </div>

        {#each groupItems(g.platform.items) as kind (kind.kind)}
          <Section title={kind.label} key="{g.platform.platform}.{kind.kind}" variant="plain" level={3} count={kind.items.length}>
            <ul class="items">
              {#each kind.items as item (item.id)}
                {@const badge = stateBadge(item.state)}
                {@const errors = errorsOf(item)}
                {@const warnings = warningsOf(item)}
                {@const edit = editHref(item, g.appId, null)}
                {@const key = `${g.appId}/${item.id}`}
                {@const open = expanded.has(key)}
                {@const thumbs = thumbsOf(item, cartRowsOf(g.appId))}
                <li class="item" class:being-published={running !== null} id={itemAnchor(g.appId, item.id)} tabindex="-1" data-testid="pending-item">
                  <div class="main">
                    <p class="name">
                      <button
                        type="button"
                        class="ghost icon sm"
                        aria-expanded={open}
                        aria-controls="{uid}-{key}-p"
                        aria-label={t(PREVIEW_KEYS[open ? 'collapse' : 'expand'], { title: item.label })}
                        onclick={() => (expanded = toggleExpanded(expanded, key))}
                      >
                        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
                      </button>
                      <strong>{item.label}</strong>
                      {#if running}<Badge tone="info" icon="refresh">{t('publish:publishing.itemBadge')}</Badge>{:else}<Badge tone={badge.tone} icon={item.state === 'invalid' ? 'alert-triangle' : undefined}>{badge.label}</Badge>{/if}
                      {#if item.since !== null}<span class="muted when">{t('publish:pending.since', { when: timeAgo(item.since, now) })}</span>{/if}
                    </p>
                    {#if item.kind === 'asset_set' && thumbs.thumbs.length > 0}
                      <CartGraphicsDetail files={item.counts.files ?? 0} before={thumbs.before} thumbs={thumbs.thumbs} line={false} />
                    {/if}
                    {#each errors as p (p.code + p.message + (p.item ?? ''))}
                      <p class="problem bad"><Icon name="x-circle" size={14} /> {p.message}</p>
                    {/each}
                    {#each warnings as p (p.code + p.message + (p.item ?? ''))}
                      <p class="problem warn">{p.message}</p>
                    {/each}
                    {#if item.truncated}<p class="muted small">{t('publish:pending.truncated', { count: item.refs.length })}</p>{/if}
                    <p class="next muted">{running ? t('publish:publishing.rowReason') : nextStepText(item)}</p>
                  </div>
                  {#if item.nextStep !== null || isDiscardable(item)}
                    <div class="actions">
                      <Button size="sm" variant="ghost" href={edit.href}>{edit.label}</Button>
                      {#if mayEdit && isDiscardable(item)}
                        {#if confirming === key}
                          <span class="confirm" role="group" aria-label={t('publish:pending.discardAria', { label: item.label })}>
                            <Button size="sm" variant="danger" loading={removing === key} disabled={busy} onclick={() => discard(g.appId, item)}>{t('publish:pending.yesDiscard')}</Button>
                            <Button size="sm" disabled={busy} onclick={() => (confirming = '')}>{t('publish:pending.keep')}</Button>
                          </span>
                        {:else}
                          <Button size="sm" variant="ghost" icon="x" disabled={busy || held(g.appId)} title={held(g.appId) ? publishingReason : undefined} aria-label={t('publish:pending.discardItem', { label: item.label })} onclick={() => (item.refs.length > 1 ? (confirming = key) : discard(g.appId, item))}>{t('publish:pending.discard')}</Button>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                  {#if open}
                    <PendingItemPreview
                      {api}
                      {workspaceId}
                      appId={g.appId}
                      {item}
                      cartRows={cartRowsOf(g.appId)}
                      cartFailed={carts[g.appId] === 'failed'}
                      id="{uid}-{key}-p"
                      onretry={() => void loadCart(g.appId)}
                    />
                  {/if}
                </li>
              {/each}
            </ul>
          </Section>
        {/each}
      </section>
    {/each}

    {#if emptyPlatforms.length > 0}<p class="muted small">{t('publish:pending.nothingOn', { platforms: formatList(emptyPlatforms) })}</p>{/if}
    {#if lastSynced !== null}
      <p class="muted small">{t('publish:pending.lastSynced', { when: timeAgo(lastSynced, now) })}</p>
    {/if}
  {/if}

  {#if publishOpen && dialogTargets.length > 0}
    <PublishDialog bind:open={publishOpen} {api} {workspaceId} targets={dialogTargets} steps={dialogSteps} onchanged={changed} />
  {/if}
</section>

<style>
  .pending {
    display: grid;
    gap: var(--space-4);
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
    align-items: center;
    justify-content: space-between;
  }

  .line {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .small {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .blocked {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--bad-ink);
  }

  .blocked-box {
    display: grid;
    gap: var(--space-2);
  }

  .blockers {
    display: grid;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    font-size: var(--text-sm);
    list-style: none;
  }

  .blockers li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .empty {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .group {
    display: grid;
    gap: var(--space-4);
  }

  .group-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .confirm {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
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
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  /* Being written by the publish that runs now: shown, but quiet, and nothing on it can be changed. */
  .item.being-published {
    background: var(--surface);
    border-style: dashed;
  }

  .item.being-published .name strong {
    color: var(--muted);
  }

  .main {
    display: grid;
    flex: 1;
    gap: var(--space-1);
    min-width: 240px;
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .when {
    font-size: var(--text-sm);
  }

  .problem {
    display: flex;
    gap: var(--space-1);
    align-items: flex-start;
    margin: 0;
    font-size: var(--text-sm);
  }

  .problem.bad {
    color: var(--bad-ink);
  }

  .problem.warn {
    color: var(--warn-ink);
  }

  .next {
    margin: 0;
    font-size: var(--text-sm);
  }

  .act {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
