<!--
  StatusBadge: the state of a change set as a Badge. Props: status (draft, approved, applying,
  applied, failed or discarded). The text says the state; the tone only backs it up.
-->
<script lang="ts">
  import type { ChangeSetStatus } from '@mrm/core';
  import { changeSetStatusInfo } from '../../lib/repositories.ts';
  import Badge from '../ui/Badge.svelte';

  let { status }: { status: ChangeSetStatus } = $props();
  const info = $derived(changeSetStatusInfo(status));
</script>

<Badge tone={info.tone} dot={info.dot}>{info.label}</Badge>
