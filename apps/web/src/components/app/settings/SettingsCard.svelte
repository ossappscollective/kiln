<!--
  SettingsCard: one section of the app Settings: a card with a title, one sentence on what the section is, the content and (when there is
  no API for something) one muted "not available yet" line with the reason. Always open: the Settings page shows one section at a time in a
  rail (SectionRail), so there is nothing to collapse into and no setting hides behind a toggle.
  Props: title, icon, description, unavailable? (a sentence, shown muted at the end), children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '../../../lib/icons.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import Card from '../../ui/Card.svelte';
  import Icon from '../../ui/Icon.svelte';

  let {
    title,
    icon,
    description,
    unavailable = undefined,
    children,
  }: {
    title: string;
    icon: IconName;
    description: string;
    unavailable?: string | undefined;
    children: Snippet;
  } = $props();
</script>

<Card {title}>
  <div class="stack">
    <p class="muted desc"><Icon name={icon} size={14} /> {description}</p>
    {@render children()}
    {#if unavailable}
      <p class="muted na"><strong>{t('app:settings.notAvailable')}</strong> {unavailable}</p>
    {/if}
  </div>
</Card>

<style>
  .desc,
  .na {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .desc {
    max-width: 68ch;
  }
</style>
