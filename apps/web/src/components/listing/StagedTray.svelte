<!--
  StagedTray: where the staged listing changes of an app collect (docs/ux-ia.md, section 4), shown on the
  Listing and Assets tabs. One block per platform record in scope. Edits join it ("Stage from repo" on the
  Listing tab, "Stage for store" on the Assets tab); from here a person removes items, clears all, and pushes
  them to the store as a DRAFT, in one batch per store, after a preview and a confirmation.
  Pushing is not submitting: nothing here sends for review or publishes, and says so. Submit and publish
  are not built yet (a note stands where the button would be).
  Props: api, workspaceId, role, members (the app records in scope).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { NOT_SUBMITTED, SUBMIT_NOT_BUILT } from '../../lib/staged.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import StagedTrayApp from './StagedTrayApp.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
</script>

<section class="tray card" aria-labelledby="{uid}-title" data-testid="staged-tray">
  <div class="stack">
    <div class="head">
      <h3 id="{uid}-title"><Icon name="layers" size={16} /> Staged changes</h3>
      <Badge tone="neutral">Store write, gated</Badge>
    </div>
    <p class="muted note">
      Changes collect here, one tray per store, and are pushed to the store's draft in one batch after a preview. {NOT_SUBMITTED}
    </p>

    {#each members as app (app.id)}
      <StagedTrayApp {api} {workspaceId} {role} {app} showPlatform={members.length > 1} />
    {/each}

    <p class="muted note submit-note"><Icon name="info" size={14} /> {SUBMIT_NOT_BUILT}</p>
  </div>
</section>

<style>
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
    margin: 0;
    font-size: var(--text-sm);
  }

  .submit-note {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }
</style>
