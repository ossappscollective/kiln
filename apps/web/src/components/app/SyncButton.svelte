<!--
  SyncButton: the one Sync of an app page, split in two (docs/ux-ia.md "Sync is per page"). The main action reads ONLY what this page needs and
  what is not fresh: Insights its analytics sources (failed first, a source read recently is left alone), Reviews the reviews, Products the products and
  RevenueCat, Builds EAS and TestFlight, every other page the store listing. Its label says what it will do ("Sync analytics"); when something this
  page reads failed it becomes "Retry failed (2)" and reads only those. The chevron opens the rest: "Sync everything", "Only failed", and one entry
  per kind with its last read and its own Sync. Progress and failures stay in the Status popover (SyncSources), the one place for per-source detail.
  The plan is lib/sync-plan.ts (pure); the readings are the sources' own stored status, loaded for the page's kinds and, once the menu is opened,
  for every kind. Props: api, workspaceId, role, members (the records in scope), section (the page), now, busy (a run is going), refreshKey (changes
  when a run ended, so the readings load again), onrun (targets, everything: the shell runs them; `everything` also reads the store listing).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { AppSection } from '../../lib/app-scope.ts';
  import { formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { type SyncTarget, failedCount, kindAllowed, mainLabelKey, planPage, PAGE_KINDS, runProgress, syncPageFor } from '../../lib/sync-plan.ts';
  import { loadReadings } from '../../lib/sync-readings.ts';
  import { syncRun } from '../../lib/sync-run.svelte.ts';
  import { SYNC_KINDS, type SourceInput, kindLabel } from '../../lib/sync-sources.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    section,
    now,
    busy,
    refreshKey = 0,
    onrun,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    section: AppSection;
    now: number;
    busy: boolean;
    refreshKey?: number | undefined;
    onrun: (targets: SyncTarget[], everything: boolean) => void;
  } = $props();

  const page = $derived(syncPageFor(section));
  let inputs = $state<SourceInput[]>([]);
  let readAt = $state(Date.now());
  /** The other kinds are read only once the menu was opened: most pages never need them. */
  let wide = $state(false);
  let open = $state(false);
  let generation = 0;

  $effect(() => {
    void refreshKey;
    void syncRun.active;
    void members.map((m) => m.id).join(',');
    const kinds = wide ? SYNC_KINDS : PAGE_KINDS[page];
    untrack(() => {
      const mine = ++generation;
      void loadReadings(api, workspaceId, role, members, kinds).then((read) => {
        if (mine !== generation) return;
        inputs = read;
        readAt = Date.now();
      });
    });
  });
  $effect(() => {
    if (open) wide = true;
  });

  const plan = $derived(planPage(inputs, { page, now: Math.max(readAt, now), allowed: (kind) => kindAllowed(role, kind) }));
  const label = $derived.by(() => {
    if (plan.main === null) return t('app:syncButton.everything');
    const l = mainLabelKey(plan);
    return l.failed === null ? t(l.key) : t(l.key, { failed: l.failed });
  });
  const progress = $derived(runProgress(syncRun.runs));
  const busyText = $derived(progress.total > 0 ? t('app:syncButton.progress', progress) : t('app:statusPopover.syncing'));
  const title = $derived(plan.main === null ? t('app:syncButton.noPage') : plan.main.mode === 'fresh' ? t('app:syncButton.upToDate') : undefined);

  function run(targets: SyncTarget[], everything = false) {
    open = false;
    if (busy || (targets.length === 0 && !everything)) return;
    onrun(targets, everything);
  }
  const main = () => (plan.main === null ? run(plan.everything, true) : run(plan.main.targets));
  const readText = (lastReadAt: number | null) =>
    lastReadAt === null ? t('app:sync.neverRead') : t('app:sync.lastRead', { ago: formatRelativeTime(lastReadAt, { now: Math.max(readAt, now) }) });
</script>

<div class="split" data-testid="sync-button">
  <Button size="sm" icon="refresh" loading={busy} disabled={busy || (plan.main === null && plan.everything.length === 0)} {title} onclick={main}>{busy ? busyText : label}</Button>
  <InfoTip label={t('app:syncButton.more')} icon="chevron-down" align="end" width="24rem" bind:open>
    <div class="menu">
      <h3>{t('app:syncButton.menuTitle')}</h3>
      {#if plan.everything.length === 0}
        <p class="muted">{t('app:syncButton.none')}</p>
      {:else}
        <div class="top">
          <Button size="sm" disabled={busy} onclick={() => run(plan.everything, true)}>{t('app:syncButton.everything')}</Button>
          {#if plan.failed.length > 0}
            <Button size="sm" disabled={busy} onclick={() => run(plan.failed)}>{t('app:syncButton.onlyFailed', { failed: failedCount(plan.failed) })}</Button>
          {/if}
        </div>
        <ul>
          {#each plan.menu as m (m.kind)}
            <li data-state={m.freshness}>
              <div class="what">
                <strong>{kindLabel(m.kind)}</strong>
                <span class="muted when">
                  {#if m.freshness === 'failed'}<Badge tone="bad" dot>{t('app:sync.state.failed')}</Badge>{/if}
                  {readText(m.lastReadAt)}
                </span>
              </div>
              <Button size="sm" variant="ghost" disabled={busy || m.targets.length === 0} label={t('app:syncButton.runKind', { kind: kindLabel(m.kind) })} onclick={() => run(m.targets)}>{t('app:syncButton.run')}</Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </InfoTip>
</div>

<style>
  /* One joined control: label | divider | chevron share the border, the radius and the surface. The inner buttons drop their own
     border, radius and shadow (the selectors are as specific as the global button states and InfoTip's own trigger rules, so they win);
     the focus ring is drawn inside each part so the wrapper never has to clip it. */
  .split {
    display: inline-flex;
    align-items: stretch;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xs);
  }

  .split :global(button),
  .split :global(button.trigger) {
    color: var(--ink);
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .split > :global(button) {
    border-radius: calc(var(--radius-md) - 1px) 0 0 calc(var(--radius-md) - 1px);
  }

  .split :global(.infotip) {
    border-left: 1px solid var(--line-strong);
  }

  .split :global(button.trigger) {
    min-height: var(--control-sm);
    border-radius: 0 calc(var(--radius-md) - 1px) calc(var(--radius-md) - 1px) 0;
  }

  .split :global(button:hover:not(:disabled)),
  .split :global(button.trigger:hover),
  .split :global(button.trigger[aria-expanded='true']) {
    color: var(--ink);
    background: var(--surface-hover);
    border: 0;
  }

  .split :global(button:active:not(:disabled)) {
    background: var(--surface-active);
  }

  .split :global(button:focus-visible) {
    outline: var(--ring);
    outline-offset: -2px;
    box-shadow: none;
  }

  .menu {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  ul {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) 0;
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .when {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .muted {
    color: var(--muted);
  }
</style>
