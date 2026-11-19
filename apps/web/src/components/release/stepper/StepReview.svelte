<!--
  StepReview: the fourth step of "Prepare release": everything staged for this app, with what the store has now beside it, and
  remove or clear. A thin wrapper (props only) around the existing staged tray, items part. Nothing is sent to a store from here.
  It is kept this small so a later "Pending changes" overview can replace it without touching the stepper.
  Props: api, workspaceId, role, app, confirmVisible (whether the last step is shown, for one sentence).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import StagedTrayApp from '../../listing/StagedTrayApp.svelte';

  let { api, workspaceId, role, app, confirmVisible }: { api: Api; workspaceId: string; role: Role; app: AppSummary; confirmVisible: boolean } = $props();
</script>

<div class="stack">
  <p class="lead">Everything staged for this release, with what the store has now beside it. Remove what you do not want. Nothing here is sent to the store.</p>
  <StagedTrayApp {api} {workspaceId} {role} {app} part="items" />
  {#if confirmVisible}<p class="muted small">Pushing the staged changes to the store draft is the last step.</p>{/if}
</div>

<style>
  .lead,
  .small {
    margin: 0;
  }

  .small {
    font-size: var(--text-sm);
  }
</style>
