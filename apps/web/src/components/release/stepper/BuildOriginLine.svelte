<!--
  BuildOriginLine: the second line of a build in "Prepare release": which version the build is and when it was built, as far as Kiln
  knows (lib/build-origin.ts; the server joins the CI files it read, the synced store builds and the name of the release). It never
  guesses: a version Kiln has not read says so, with a way to find it in CI builds; Google Play never gives a build date, so
  that is said too. The hover text of each part says where it came from.
  Props: origin (the OriginView), findHref? (the Test builds page of the app, offered when the version is not known),
  sayUnknown? (say "not known" for a missing version or date; false for App Store builds, which always have both).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import type { OriginView } from '../../../lib/build-origin.ts';

  let {
    origin,
    findHref = null,
    sayUnknown = true,
  }: {
    origin: OriginView;
    findHref?: string | null | undefined;
    sayUnknown?: boolean | undefined;
  } = $props();

  const showVersion = $derived(sayUnknown || !origin.versionUnknown);
  const showBuilt = $derived(sayUnknown || origin.builtKnown);
</script>

{#if showVersion || showBuilt || origin.run}
  <span class="origin" data-testid="build-origin">
    {#if showVersion}<span class="part" class:unknown={origin.versionUnknown} title={origin.versionTitle}>{origin.versionText}</span>{/if}
    {#if showVersion && origin.versionUnknown && findHref}<a class="find" href={findHref}>{t('release-stepper:og.findInCi')}</a>{/if}
    {#if showBuilt}<span class="part" class:unknown={!origin.builtKnown} title={origin.builtTitle}>{origin.builtText}</span>{/if}
    {#if origin.run}
      {#if origin.run.url}<a class="find" href={origin.run.url} target="_blank" rel="noreferrer" title={origin.run.title}>{origin.run.text}</a>{:else}<span class="part" title={origin.run.title}>{origin.run.text}</span>{/if}
    {/if}
  </span>
{/if}

<style>
  .origin {
    display: flex;
    flex: 1 0 100%;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: center;
    font-size: var(--text-sm);
    color: var(--ink);
  }

  .part {
    min-width: 0;
  }

  .part.unknown {
    color: var(--muted);
  }

  .find {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
