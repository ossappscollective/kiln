<!--
  PublishingNote: the one muted line that sits next to a button that is off because of the state of the app: a publish of it is running
  ("A publish of this app is running (started 3 minutes ago). Wait for it to finish, then try again.") or the last one failed ("Resolve the
  failed publish first."), with a link to the pending changes where it can be followed or fixed. It only SHOWS a verdict; the verdict is
  the app-state model's (`appStateStore.verdict`), and so is the button's disabled state. Draws nothing for any other verdict.
  Props: verdict (from the app-state store), appId (the record), platform? (the scope of the link).
-->
<script lang="ts">
  import { type PlatformScope, appAddress } from '../../lib/app-scope.ts';
  import type { Verdict } from '../../lib/app-state/types.ts';
  import { t } from '../../lib/i18n/t.ts';

  let {
    verdict,
    appId,
    platform = null,
  }: { verdict: Verdict; appId: string; platform?: PlatformScope | null | undefined } = $props();

  const shown = $derived(!verdict.enabled && (verdict.code === 'publishing' || verdict.code === 'publish_failed') && verdict.reason !== null);
</script>

{#if shown}
  <p class="muted small note" data-testid="publishing-note" data-code={verdict.code}>
    {verdict.reason}
    <a href={appAddress(appId, 'pending', platform ?? null)}>
      {verdict.code === 'publishing' ? t('publish:publishing.seeProgress') : t('publish:publishing.showPending')}
    </a>
  </p>
{/if}

<style>
  .note {
    margin: 0;
  }
</style>
