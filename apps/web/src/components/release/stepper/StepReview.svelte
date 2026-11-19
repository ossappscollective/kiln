<!--
  StepReview: the fourth step of "Prepare release": everything pending for this app in one list (the same view as the "Pending changes"
  section: staged texts, graphics and release fields, drafts pushed and not yet submitted, what is approved or in review), with a link
  to change each item and a discard for staged ones. Under a quiet "Advanced" disclosure the staged tray (each staged item beside what
  the store has now, remove and clear) is still here. Nothing is sent to a store from here.
  Props: api, workspaceId, role, app, confirmVisible (whether the last step is shown, for one sentence).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import StagedTrayApp from '../../listing/StagedTrayApp.svelte';
  import PendingChanges from '../../publish/PendingChanges.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';

  let { api, workspaceId, role, app, confirmVisible }: { api: Api; workspaceId: string; role: Role; app: AppSummary; confirmVisible: boolean } = $props();
</script>

<div class="stack">
  <p class="lead">Everything that is pending for this app, in one list. Remove or fix what you do not want. Nothing here is sent to the store.</p>
  <PendingChanges {api} {workspaceId} {role} members={[app]} compact />
  <Disclosure summary="Advanced: compare each staged item with the store" stateKey="stepper-review-advanced-{app.id}">
    <StagedTrayApp {api} {workspaceId} {role} {app} part="items" />
  </Disclosure>
  {#if confirmVisible}<p class="muted small">Review and publish all is the last step.</p>{/if}
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
