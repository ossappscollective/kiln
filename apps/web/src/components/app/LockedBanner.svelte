<!--
  LockedBanner: one slim line above a page whose metadata cannot change because the selected version is
  live (or in review where the store forbids edits): "This version is live — metadata is locked", with a
  link to prepare a new version on the Releases tab. The page below shows read-only fields and no Save,
  Stage or Submit controls.
  Props: text (the sentence, from lockInfo), href (the Releases tab of the app).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import Icon from '../ui/Icon.svelte';

  let { text, href }: { text: string; href: string } = $props();
</script>

<p class="lock" role="status">
  <Icon name="lock" size={14} />
  <span>{text}.</span>
  <a href={href}>{t('app:lock.prepare')}</a>
</p>

<style>
  .lock {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
    color: var(--muted);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .lock span {
    color: var(--ink);
  }
</style>
