<!--
  ReleasePreviewBody: what a release would do, as its confirmation shows it: the facts (app, track or version, build, who gets it),
  the other releases of the track (read only), what cannot be undone in plain words, and the checks. Display only: it sends nothing
  and asks for nothing. Used by StoreReleaseDialog and by the batch publish dialog, so a release looks the same in both.
  Props: preview (the release preview of the server).
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { type ReleasePreview, audienceText, directText, percentText, storeConsole } from '../../lib/store-release.ts';
  import Alert from '../ui/Alert.svelte';
import { supports } from '@kiln/core';

  let { preview }: { preview: ReleasePreview } = $props();

  const blocking = $derived(preview.checks.blocking);
  const codesLine = $derived(preview.release && preview.release.versionCodes.length > 0 ? preview.release.versionCodes.join(', ') : t('publish:release.none'));
  const android = $derived(supports(preview.app.platform, 'releaseTracks'));
  const console_ = $derived(storeConsole(preview.app.platform));
  const directLine = $derived(directText(preview));
  const OTHER_LINE = {
    plain: k('publish:release.other.plain'),
    fraction: k('publish:release.other.fraction'),
    replaced: k('publish:release.other.replaced'),
    fractionReplaced: k('publish:release.other.fractionReplaced'),
  };
  const otherLine = (other: ReleasePreview['others'][number]): string => {
    const replaced = android && preview.audience.kind === 'all' && other.status === 'completed';
    const fraction = other.userFraction !== null;
    const key = fraction ? (replaced ? OTHER_LINE.fractionReplaced : OTHER_LINE.fraction) : replaced ? OTHER_LINE.replaced : OTHER_LINE.plain;
    return t(key, {
      name: other.name ?? t('publish:release.unnamed'),
      status: other.status,
      percent: other.userFraction !== null ? percentText(other.userFraction) : '',
      codes: other.versionCodes.join(', ') || t('publish:release.none'),
    });
  };
</script>

<div class="stack">
  {#if directLine && preview.direct}
    <Alert tone="warn" title={preview.direct.creates ? t('publish:release.directCreates') : t('publish:release.directExisting')}>
      <p class="alert-text" data-testid="release-direct">{directLine}</p>
    </Alert>
  {/if}
  <dl class="facts" data-testid="release-facts">
    <div><dt>{t('publish:preview.app')}</dt><dd>{preview.app.name}</dd></div>
    {#if android}
      <div><dt>{t('publish:release.track')}</dt><dd>{preview.track ?? t('publish:release.notKnown')}</dd></div>
      {#if preview.release}
        <div><dt>{t('publish:release.release')}</dt><dd>{t('publish:release.releaseLine', { name: preview.release.name ?? t('publish:release.unnamed'), status: preview.release.status })}</dd></div>
        <div><dt>{t('publish:release.versionCodes')}</dt><dd>{codesLine}</dd></div>
        <div><dt>{t('publish:release.notes')}</dt><dd>{preview.direct && preview.direct.notesLanguages.length > 0 ? preview.direct.notesLanguages.join(', ') : preview.release.notes === 0 ? t('publish:release.none') : t('publish:release.notesLanguages', { count: preview.release.notes })}</dd></div>
      {/if}
    {:else}
      <div><dt>{t('publish:preview.version')}</dt><dd>{preview.version ? (preview.version.versionString ? t('publish:release.versionLine', { version: preview.version.versionString, state: preview.version.state }) : t('publish:release.notKnown')) : t('publish:release.notKnown')}</dd></div>
      {#if preview.build}<div><dt>{t('publish:preview.build')}</dt><dd>{preview.build.buildNumber ?? t('publish:release.notKnown')}</dd></div>{/if}
      <div><dt>{t('publish:release.phased')}</dt><dd>{preview.phasedRelease ? (preview.phasedRelease.state ? t('publish:release.phasedOnState', { state: preview.phasedRelease.state }) : t('publish:release.phasedOn')) : t('publish:release.phasedOff')}</dd></div>
    {/if}
    <div><dt>{t('publish:release.whoGetsIt')}</dt><dd>{audienceText(preview)}</dd></div>
    <div><dt>{t('publish:preview.storeRead')}</dt><dd>{fullTime(preview.readAt)}</dd></div>
  </dl>

  {#if preview.others.length > 0}
    <section class="stack tight" aria-label={t('publish:release.othersTitle')}>
      <h3>{t('publish:release.othersTitle')}</h3>
      <ul class="plain">
        {#each preview.others as other (`${other.name}/${other.status}/${other.versionCodes.join(',')}`)}
          <li>{otherLine(other)}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="stack tight" aria-label={t('publish:preview.cannotUndoAria')}>
    <h3>{t('publish:preview.cannotUndoTitle')}</h3>
    <ul class="plain" data-testid="release-irreversible">
      {#each preview.irreversible as sentence (sentence)}<li>{sentence}</li>{/each}
    </ul>
  </section>

  {#if blocking.length > 0}
    <Alert tone="error" title={t('publish:release.blockedTitle')}>
      <ul class="plain" data-testid="release-blocking">
        {#each blocking as check (check.code + check.message + (check.item ?? ''))}<li>{check.message}</li>{/each}
      </ul>
      <p class="para">{t('publish:release.blockedFix', { console: console_ })}</p>
    </Alert>
  {/if}
  {#if preview.checks.warnings.length > 0}
    <Alert tone="warn" title={t('publish:preview.readFirst')}>
      <ul class="plain" data-testid="release-warnings">
        {#each preview.checks.warnings as check (check.code + check.message + (check.item ?? ''))}<li>{check.message}</li>{/each}
      </ul>
    </Alert>
  {/if}
</div>

<style>
  h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .tight {
    gap: var(--space-2);
  }

  .para {
    margin: var(--space-1) 0 0;
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .facts dt {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
