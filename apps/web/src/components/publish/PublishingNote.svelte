<!--
  PublishingNote: the one muted line that sits next to a button that is off because a publish of the app is running ("A publish of this
  app is running (started 3 minutes ago). Wait for it to finish, then try again."), with a link to the pending panel where it can be
  followed. Draws nothing when the app is not publishing. The button itself is disabled by the caller with `publishingStore.isPublishing`.
  Props: workspaceId, appId (the record), platform? (the scope of the link).
-->
<script lang="ts">
  import { type PlatformScope, appAddress } from '../../lib/app-scope.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { publishingStore } from '../../lib/publishing-store.svelte.ts';

  let {
    workspaceId,
    appId,
    platform = null,
  }: { workspaceId: string; appId: string; platform?: PlatformScope | null | undefined } = $props();

  let now = $state(Date.now());
  const reason = $derived(publishingStore.reason(workspaceId, appId, now));
  $effect(() => {
    if (reason === '') return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
</script>

{#if reason !== ''}
  <p class="muted small note" data-testid="publishing-note">
    {reason}
    <a href={appAddress(appId, 'pending', platform ?? null)}>{t('publish:publishing.seeProgress')}</a>
  </p>
{/if}

<style>
  .note {
    margin: 0;
  }
</style>
