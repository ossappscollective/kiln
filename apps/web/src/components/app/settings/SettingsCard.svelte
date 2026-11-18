<!--
  SettingsCard: one section of the app Settings tab: a heading with an icon, one sentence on what the
  section is, the content, and (when there is no API for something) a muted "not available yet" line.
  Props: title, icon, description, unavailable? (a sentence, shown muted at the end), children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '../../../lib/icons.ts';
  import Icon from '../../ui/Icon.svelte';

  let {
    title,
    icon,
    description,
    unavailable = undefined,
    children,
  }: { title: string; icon: IconName; description: string; unavailable?: string | undefined; children: Snippet } = $props();

  const uid = $props.id();
</script>

<section class="card" aria-labelledby="{uid}-title">
  <div class="stack">
    <div>
      <h3 id="{uid}-title"><Icon name={icon} size={16} /> {title}</h3>
      <p class="muted desc">{description}</p>
    </div>
    {@render children()}
    {#if unavailable}<p class="muted na"><Icon name="clock" size={14} /> {unavailable}</p>{/if}
  </div>
</section>

<style>
  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  .desc,
  .na {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .na {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }
</style>
