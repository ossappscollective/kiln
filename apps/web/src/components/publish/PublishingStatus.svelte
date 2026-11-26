<!--
  PublishingStatus: the row that says a publish of an app is running on the server right now (docs/api/pending.md "Publishing now"):
  a spinner, "Publishing to Google Play…", when it started, which step of how many it is on, and the time it has been running, ticking.
  It is a read of the shared `publishing-store` (the caller passes the entry), so every screen says the same. Nothing here sends anything.
  Props: publishing (the entry), platform (names the store), me? (the person's id: another person's name is shown, not one's own),
  href? (a link to the pending panel, for places that are not the panel itself), appId? (the record: when the person asked to be shown
  this publish (`publishingFocus`, the top bar button), the row scrolls into view and takes focus), action? (a button beside the text,
  for example "Show pending changes"), workspaceId? (with it the row offers the way out of a publish that seems stuck: "Still running?
  Check status" reads the server's claim again, and, only when the server says the claim is silent or has run too long, "Mark as
  interrupted" ends it, for a person who may publish (`canInterrupt`). Nothing is sent to a store, and a publish that is alive and recent
  is never stopped: the server refuses). The second line also says what a long step is doing ("Uploading screenshots: 12 of 40 done") and
  when the server has gone quiet.
-->
<script lang="ts">
  import type { Platform } from '@kiln/core';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { publishingFocus } from '../../lib/publishing-focus.svelte.ts';
  import {
    byText,
    detailText,
    elapsedOf,
    headlineText,
    looksStuck,
    type Publishing,
    progressText,
    quietText,
  } from '../../lib/publishing.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let {
    publishing,
    platform,
    me = null,
    href = undefined,
    appId = undefined,
    action = undefined,
    workspaceId = undefined,
    canInterrupt = false,
  }: {
    publishing: Publishing;
    platform: Platform;
    me?: string | null | undefined;
    href?: string | undefined;
    appId?: string | undefined;
    action?: { label: string; onclick: () => void } | undefined;
    workspaceId?: string | undefined;
    canInterrupt?: boolean | undefined;
  } = $props();

  let now = $state(Date.now());
  $effect(() => {
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const who = $derived(byText(publishing, me));
  const progress = $derived(progressText(publishing));
  const quiet = $derived(quietText(publishing, now));
  const stuck = $derived(looksStuck(publishing, now));
  /** The way out: only for a server claim (not this browser's mark), with the workspace to ask about. */
  const server = $derived(publishing.heartbeatAt !== undefined && workspaceId !== undefined);
  const mayEnd = $derived(server && canInterrupt && publishing.interruptible === true);
  let busy = $state<'check' | 'end' | null>(null);
  let note = $state('');
  async function check() {
    if (workspaceId === undefined || busy !== null) return;
    busy = 'check';
    note = '';
    await appStateStore.recheckPublishing(workspaceId);
    busy = null;
    // Still here after the read: the server still reports it.
    note = t('publish:publishing.checked');
  }
  async function end() {
    if (workspaceId === undefined || appId === undefined || busy !== null) return;
    busy = 'end';
    note = '';
    const answer = await appStateStore.interruptPublish(workspaceId, appId);
    busy = null;
    note =
      answer === 'still_running'
        ? t('publish:publishing.interruptStill')
        : answer === 'failed'
          ? t('publish:publishing.interruptFailed')
          : '';
  }

  // "Show me the publish" (the top bar button, the banner): scroll this row into view and give it focus, once.
  let row = $state<HTMLDivElement>();
  $effect(() => {
    if (appId === undefined || row === undefined || publishingFocus.requested !== appId) return;
    const el = row;
    const id = appId;
    queueMicrotask(() => {
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      el.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      publishingFocus.done(id);
    });
  });
</script>

<Alert tone="info">
  <div class="publishing" data-testid="publishing-status" data-app-id={appId} tabindex="-1" bind:this={row}>
    <Spinner size={16} label={t('publish:publishing.statusAria')} />
    <div class="text">
      <strong>{headlineText(platform)}</strong>
      <!-- the ticking parts are not read out every second -->
      <span class="detail" aria-live="off">
        {detailText(publishing, now)}{#if who} · {who}{/if} ·
        <span class="elapsed">{t('publish:publishing.elapsed', { time: elapsedOf(publishing, now) })}</span>
      </span>
      {#if progress}<span class="detail" data-testid="publishing-progress">{progress}</span>{/if}
      {#if quiet}<span class="detail" data-testid="publishing-quiet">{quiet}</span>{/if}
      {#if stuck}<span class="detail" data-testid="publishing-stuck">{t('publish:publishing.stuck')}</span>{/if}
      <span class="detail">{t('publish:publishing.keepsRunning')}</span>
      {#if server}
        <span class="act" data-testid="publishing-way-out">
          <Button size="sm" variant="secondary" disabled={busy !== null} onclick={check}>{busy === 'check' ? t('publish:publishing.checking') : t('publish:publishing.check')}</Button>
          {#if mayEnd}<Button size="sm" variant="secondary" disabled={busy !== null} onclick={end}>{t('publish:publishing.interrupt')}</Button>{/if}
        </span>
        {#if mayEnd}<span class="detail" data-testid="publishing-interrupt-hint">{t('publish:publishing.interruptHint')}</span>{/if}
        {#if note}<span class="detail" role="status" data-testid="publishing-note">{note}</span>{/if}
      {/if}
      {#if href}<a class="more" {href}>{t('publish:publishing.seeProgress')}</a>{/if}
      {#if action}<span class="act"><Button size="sm" icon="arrow-right" onclick={action.onclick}>{action.label}</Button></span>{/if}
    </div>
  </div>
</Alert>

<style>
  .publishing {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .detail {
    font-size: var(--text-sm);
  }

  .elapsed {
    font-variant-numeric: tabular-nums;
  }

  .more {
    font-size: var(--text-sm);
  }

  .act {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .publishing:focus-visible {
    outline: var(--ring);
    outline-offset: 4px;
  }
</style>
