<!--
  StepUpHost: shows the StepUpDialog for the prompt that `confirmed(...)` (lib/step-up-prompt.svelte.ts) asked for.
  Mounted once in the shell. Props: api, workspaceId, email (the signed-in person, for password managers).
-->
<script lang="ts">
  import type { Api } from '../lib/api.ts';
  import { settleStepUp, stepUpPrompt } from '../lib/step-up-prompt.svelte.ts';
  import StepUpDialog from './StepUpDialog.svelte';

  let { api, workspaceId, email }: { api: Api; workspaceId: string; email?: string } = $props();
</script>

{#if stepUpPrompt.current}
  {#key stepUpPrompt.current.id}
    <StepUpDialog
      {api}
      {workspaceId}
      {email}
      action={stepUpPrompt.current.need.action}
      target={stepUpPrompt.current.need.target}
      factors={stepUpPrompt.current.need.factors}
      onGranted={(grant) => settleStepUp(grant)}
      oncancel={() => settleStepUp(undefined)}
    />
  {/key}
{/if}
