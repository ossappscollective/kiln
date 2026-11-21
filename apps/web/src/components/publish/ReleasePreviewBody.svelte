<!--
  ReleasePreviewBody: what a release would do, as its confirmation shows it: the facts (app, track or version, build, who gets it),
  the other releases of the track (read only), what cannot be undone in plain words, and the checks. Display only: it sends nothing
  and asks for nothing. Used by StoreReleaseDialog and by the batch publish dialog, so a release looks the same in both.
  Props: preview (the release preview of the server).
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { type ReleasePreview, audienceText, directText, storeConsole } from '../../lib/store-release.ts';
  import Alert from '../ui/Alert.svelte';
import { supports } from '@kiln/core';

  let { preview }: { preview: ReleasePreview } = $props();

  const blocking = $derived(preview.checks.blocking);
  const android = $derived(supports(preview.app.platform, 'releaseTracks'));
  const console_ = $derived(storeConsole(preview.app.platform));
  const directLine = $derived(directText(preview));
</script>

<div class="stack">
  {#if directLine && preview.direct}
    <Alert tone="warn" title={preview.direct.creates ? 'Made from what you staged and sent to Google Play in one step' : 'The existing draft is sent to Google Play'}>
      <p class="alert-text" data-testid="release-direct">{directLine}</p>
    </Alert>
  {/if}
  <dl class="facts" data-testid="release-facts">
    <div><dt>App</dt><dd>{preview.app.name}</dd></div>
    {#if android}
      <div><dt>Track</dt><dd>{preview.track ?? 'Not known'}</dd></div>
      {#if preview.release}
        <div><dt>Release</dt><dd>{preview.release.name ?? 'Unnamed'} ({preview.release.status})</dd></div>
        <div><dt>Version codes</dt><dd>{preview.release.versionCodes.length > 0 ? preview.release.versionCodes.join(', ') : 'None'}</dd></div>
        <div><dt>Release notes</dt><dd>{preview.direct && preview.direct.notesLanguages.length > 0 ? preview.direct.notesLanguages.join(', ') : preview.release.notes === 0 ? 'None' : `${preview.release.notes} ${preview.release.notes === 1 ? 'language' : 'languages'}`}</dd></div>
      {/if}
    {:else}
      <div><dt>Version</dt><dd>{preview.version?.versionString ?? 'Not known'}{preview.version ? ` (${preview.version.state})` : ''}</dd></div>
      {#if preview.build}<div><dt>Build</dt><dd>{preview.build.buildNumber ?? 'Not known'}</dd></div>{/if}
      <div><dt>Phased release</dt><dd>{preview.phasedRelease ? `On${preview.phasedRelease.state ? ` (${preview.phasedRelease.state})` : ''}` : 'Off'}</dd></div>
    {/if}
    <div><dt>Who gets it</dt><dd>{audienceText(preview)}</dd></div>
    <div><dt>Store read</dt><dd>{fullTime(preview.readAt)}</dd></div>
  </dl>

  {#if preview.others.length > 0}
    <section class="stack tight" aria-label="Other releases of the track">
      <h3>Other releases of the track</h3>
      <ul class="plain">
        {#each preview.others as other (`${other.name}/${other.status}/${other.versionCodes.join(',')}`)}
          <li>
            {other.name ?? 'Unnamed'}: {other.status}{other.userFraction !== null ? ` at ${Math.round(other.userFraction * 10000) / 100}%` : ''}, codes
            {other.versionCodes.join(', ') || 'none'}{android && preview.audience.kind === 'all' && other.status === 'completed' ? ' (replaced: Google Play allows only one completed release, so this one leaves the track)' : ''}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="stack tight" aria-label="What cannot be undone">
    <h3>What cannot be undone from here</h3>
    <ul class="plain" data-testid="release-irreversible">
      {#each preview.irreversible as sentence (sentence)}<li>{sentence}</li>{/each}
    </ul>
  </section>

  {#if blocking.length > 0}
    <Alert tone="error" title="Blocked: this cannot be released yet">
      <ul class="plain" data-testid="release-blocking">
        {#each blocking as check (check.code + check.message + (check.item ?? ''))}<li>{check.message}</li>{/each}
      </ul>
      <p class="para">Fix these in the store or in the release steps, then preview again. Look in {console_} if you are unsure.</p>
    </Alert>
  {/if}
  {#if preview.checks.warnings.length > 0}
    <Alert tone="warn" title="Read before you confirm">
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
