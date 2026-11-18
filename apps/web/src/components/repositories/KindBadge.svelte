<!--
  KindBadge: the detected project type of a repository as a Badge. Props: kind (fastlane, expo,
  both, unknown, or null for a repository that was never scanned).
-->
<script lang="ts">
  import { projectKindBadge } from '../../lib/repositories.ts';
  import { storeForProjectKind } from '../../lib/stores.ts';
  import type { ProjectKind } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';

  let { kind }: { kind: ProjectKind | null | undefined } = $props();
  const info = $derived(projectKindBadge(kind));
  // The tool's own glyph, a stack for both, a question mark when it was not recognized.
  const icon = $derived(
    kind === 'fastlane' || kind === 'expo' ? storeForProjectKind(kind).icon : kind === 'both' ? 'layers' : kind === 'unknown' ? 'help' : undefined,
  );
</script>

<Badge tone={info.tone} {icon}>{info.label}</Badge>
