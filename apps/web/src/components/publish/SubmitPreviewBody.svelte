<!--
  SubmitPreviewBody: what a submit would hand to the store's review, as its confirmation shows it: version, build, pushed draft, the
  contents per locale, the Google Play tracks (read only), what cannot be undone in plain words, and the checks (a blocking item
  is an error, warnings are listed). Display only: it sends nothing and asks for nothing. Used by SubmitDialog and by the batch
  publish dialog, so a submit looks the same in both.
  Props: preview (the submit preview of the server).
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { type SubmitPreview, buildLine, checkText, localeLine, pushedText, trackLine, versionLine } from '../../lib/store-submit.ts';
  import Alert from '../ui/Alert.svelte';
import { supports } from '@mrm/core';

  let { preview }: { preview: SubmitPreview } = $props();

  const blocking = $derived(preview.checks.blocking);
  const ios = $derived(!supports(preview.app.platform, 'releaseTracks'));
  const build = $derived(buildLine(preview.build));
</script>

<div class="stack">
  <dl class="facts" data-testid="submit-facts">
    <div><dt>App</dt><dd>{preview.app.name}</dd></div>
    <div><dt>Version</dt><dd>{versionLine(preview)}</dd></div>
    {#if build}<div><dt>Build</dt><dd>{build}</dd></div>{/if}
    {#if preview.contents.pushed}
      <div>
        <dt>Pushed draft</dt>
        <dd>{pushedText(preview.contents.pushed)} ({fullTime(preview.contents.pushed.pushedAt)}{preview.contents.pushed.pushedBy ? `, ${preview.contents.pushed.pushedBy}` : ''})</dd>
      </div>
    {/if}
    <div><dt>Store read</dt><dd>{fullTime(preview.readAt)}</dd></div>
  </dl>

  <section class="stack tight" aria-label="Contents">
    <h3>What goes to review</h3>
    {#if preview.contents.locales.length === 0}
      <p class="muted small">No locales were found in the draft.</p>
    {:else}
      <ul class="plain">
        {#each preview.contents.locales as locale (locale.locale)}<li>{localeLine(locale)}</li>{/each}
      </ul>
    {/if}
    {#if preview.contents.includesChangesNotPushedHere}
      <Alert tone="warn" title="Includes changes this tool did not push">
        Google Play sends every change that is held back for review, including edits made in Play Console, and does not list them. Check Play Console if
        someone else was editing.
      </Alert>
    {/if}
  </section>

  {#if preview.tracks.length > 0}
    <section class="stack tight" aria-label="Tracks">
      <h3>Tracks (read only)</h3>
      <ul class="plain">
        {#each preview.tracks as track (track.track)}<li>{trackLine(track)}</li>{/each}
      </ul>
      <p class="muted small">A submit does not start, raise or complete a rollout on any track.</p>
    </section>
  {/if}

  <section class="stack tight" aria-label="What cannot be undone">
    <h3>What cannot be undone from here</h3>
    <ul class="plain" data-testid="submit-irreversible">
      {#each preview.irreversible as sentence (sentence)}<li>{sentence}</li>{/each}
      <li>It does not release or publish anything. That stays a separate decision in {ios ? 'App Store Connect' : 'Play Console'}.</li>
    </ul>
  </section>

  {#if blocking.length > 0}
    <Alert tone="error" title="Blocked: this cannot be submitted yet">
      <ul class="plain" data-testid="submit-blocking">
        {#each blocking as check (check.code + check.message + (check.locale ?? '') + (check.item ?? ''))}<li>{checkText(check)}</li>{/each}
      </ul>
      <p class="para">Fix these in the store or the repository, then preview again.</p>
    </Alert>
  {/if}
  {#if preview.checks.warnings.length > 0}
    <Alert tone="warn" title="Read before you confirm">
      <ul class="plain" data-testid="submit-warnings">
        {#each preview.checks.warnings as check (check.code + check.message + (check.locale ?? '') + (check.item ?? ''))}<li>{checkText(check)}</li>{/each}
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

  .small {
    margin: 0;
    font-size: var(--text-sm);
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
