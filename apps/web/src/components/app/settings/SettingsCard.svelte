<!--
  SettingsCard: one section of the app Settings tab: a heading with an icon, one sentence on what the
  section is, the content, and (when there is no API for something) a muted "not available yet" line.
  Collapsible (ui/Section.svelte): the title is the toggle, remembered per page; `summary` says what is set while it is collapsed.
  Props: title, icon, description, unavailable? (a sentence, shown muted at the end), summary? (one line while collapsed), key? (defaults
  to the title), defaultOpen? = true, children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '../../../lib/icons.ts';
  import Icon from '../../ui/Icon.svelte';
  import Section from '../../ui/Section.svelte';

  let {
    title,
    icon,
    description,
    unavailable = undefined,
    summary,
    key,
    defaultOpen = true,
    children,
  }: {
    title: string;
    icon: IconName;
    description: string;
    unavailable?: string | undefined;
    summary?: string;
    key?: string;
    defaultOpen?: boolean;
    children: Snippet;
  } = $props();
</script>

<Section {title} key={key ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-')} {summary} {defaultOpen}>
  <div class="stack">
    <p class="muted desc"><Icon name={icon} size={14} /> {description}</p>
    {@render children()}
    {#if unavailable}<p class="muted na"><Icon name="clock" size={14} /> {unavailable}</p>{/if}
  </div>
</Section>

<style>
  .desc,
  .na {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .na {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }
</style>
