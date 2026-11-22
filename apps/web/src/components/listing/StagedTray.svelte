<!--
  StagedTray: where the staged listing changes of an app collect (docs/ux-ia.md, section 4), shown on the
  Listing and Assets tabs. One block per platform record in scope. Edits join it ("Stage from repo" on the
  Listing tab, "Stage for store" on the Assets tab); from here a person removes items, clears all, and pushes
  them to the store as a DRAFT, in one batch per store, after a preview and a confirmation.
  Pushing is not submitting: a push never sends for review or publishes, and says so. Once a draft was pushed,
  a slim "Draft pushed — ready to submit?" line (SubmitReady, admin and up, when the server allows it) stands
  under the tray; publishing is never done by this tool.
  While nothing is staged (also when pushing is switched off or the changes could not be read) the tray is one
  slim line with a disclosure; the full tray, with its notes and buttons, is drawn as soon as something is staged.
  Props: api, workspaceId, role, members (the app records in scope).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { itemCount, notSubmittedNote, pushAvailability, submitNextStepNote } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { trayIsFull, trayLine } from '../../lib/staged-tray.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import StagedTrayApp from './StagedTrayApp.svelte';
  import SubmitReady from './SubmitReady.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();

  // The slim line needs to know whether anything is staged before the full tray is drawn, so the tray
  // reads the views itself (once per app; a view the listing already read is not read again).
  let failed = $state<Record<string, boolean | undefined>>({});
  let answered = $state<Record<string, boolean | undefined>>({});

  async function loadOne(id: string) {
    const message = await stagedStore.load(api, workspaceId, id);
    failed[id] = message !== '';
    answered[id] = true;
  }

  function loadAll(force: boolean) {
    for (const app of members) {
      if (!force && stagedStore.view(app.id) !== null) continue;
      void loadOne(app.id);
    }
  }

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        failed = {};
        answered = {};
        loadAll(false);
      }
    });
  });
  $effect(() => {
    void stagedStore.loadConfig(api, workspaceId);
  });

  const items = $derived(members.reduce((n, m) => n + itemCount(stagedStore.view(m.id)), 0));
  const full = $derived(trayIsFull({ items }));
  const line = $derived(
    trayLine({
      items,
      loading: members.some((m) => stagedStore.view(m.id) === null && answered[m.id] !== true),
      loadFailed: members.some((m) => stagedStore.view(m.id) === null && failed[m.id] === true),
      availability: pushAvailability(role, stagedStore.config(workspaceId), stagedStore.configFailed(workspaceId)).state,
    }),
  );
  const retry = $derived(line.tone === 'bad');
</script>

{#snippet content()}
  <div class="stack">
    {#each members as app (app.id)}
      <StagedTrayApp {api} {workspaceId} {role} {app} showPlatform={members.length > 1} />
    {/each}

    <details class="how">
      <summary>{t('listing:tray.howTitle')}</summary>
      <p class="muted note">
        {t('listing:tray.howBody', { note: notSubmittedNote() })}
      </p>
      <p class="muted note submit-note"><Icon name="info" size={14} /> {submitNextStepNote()}</p>
    </details>
  </div>
{/snippet}

{#if full}
  <section class="tray card" aria-labelledby="{uid}-title" data-testid="staged-tray">
    <div class="stack">
      <div class="head">
        <h3 id="{uid}-title"><Icon name="layers" size={16} /> {t('listing:tray.title')}</h3>
        <Badge tone="neutral">{t('listing:tray.badge')}</Badge>
      </div>
      {@render content()}
    </div>
  </section>
{:else}
  <!-- Nothing staged, switched off or failed to load: one slim line. The full tray is one click away. -->
  <section class="tray slim" aria-label={t('listing:tray.title')} data-testid="staged-tray">
    <Disclosure stateKey="staged.slim" variant="boxed">
      {#snippet summary()}
        <span class="title"><Icon name="layers" size={14} /> {t('listing:tray.title')}</span>
        <span class="line {line.tone}">{line.text}</span>
      {/snippet}
      {#snippet meta()}<Badge tone="neutral">{t('listing:tray.badge')}</Badge>{/snippet}
      {@render content()}
    </Disclosure>
    {#if retry}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => loadAll(true)}>{t('common:action.tryAgain')}</Button></div>
    {/if}
  </section>
{/if}

<!-- Only for admin and up, and only while a draft push is waiting to be submitted; otherwise nothing is drawn. -->
{#each members as app (app.id)}
  <SubmitReady {api} {workspaceId} {role} {app} showPlatform={members.length > 1} />
{/each}

<style>
  .slim {
    position: relative;
  }

  .slim .title {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin-right: var(--space-3);
    font-weight: var(--weight-semibold);
  }

  .line {
    font-weight: var(--weight-regular);
    color: var(--muted);
  }

  .line.bad {
    color: var(--bad-ink);
  }

  .retry {
    padding: 0 var(--space-3) var(--space-2) var(--space-6);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  .note {
    margin: var(--space-2) 0 0;
    font-size: 0.9375rem;
  }

  .how summary {
    font-size: 0.9375rem;
    cursor: pointer;
  }

  .submit-note {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }
</style>
