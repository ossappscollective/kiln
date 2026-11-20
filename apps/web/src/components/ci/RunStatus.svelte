<!--
  RunStatus: the state of a CI run as a Badge. The text always says the state (Running, Succeeded,
  Failed, ...), so the colour is never the only signal.
  Props: run (anything with status and conclusion).
-->
<script lang="ts">
  import { runBadge } from '../../lib/ci/ci.ts';
  import type { WorkflowRun } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';

  let { run }: { run: Pick<WorkflowRun, 'status' | 'conclusion'> } = $props();

  const badge = $derived(runBadge(run));
</script>

<Badge tone={badge.tone} dot={badge.dot}>{badge.label}</Badge>
