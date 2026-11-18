<!--
  KindBadge: the detected project type of a repository as a Badge. Props: kind (fastlane, expo,
  both, unknown, or null for a repository that was never scanned).
-->
<script lang="ts">
  import { projectKindBadge } from '../../lib/repositories.ts';
  import type { ProjectKind } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';

  let { kind }: { kind: ProjectKind | null | undefined } = $props();
  const info = $derived(projectKindBadge(kind));
</script>

<Badge tone={info.tone}>{info.label}</Badge>
