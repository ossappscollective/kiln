<!--
  SubmitDialog: the confirmation of ONE submit of a pushed draft to the store's review. It shows what goes to
  review (version, build, contents per locale, the Google Play tracks, read only), what cannot be undone in
  plain words, the checks (a blocking item blocks the button; warnings are listed), a clear statement that this
  goes to the store's review and is NOT released or published by this tool, and a typed phrase that must equal
  the preview's phrase exactly as the server gave it.
  It sends nothing itself: `onconfirm(typed)` is called once per click and the parent sends the preview's hash
  and the typed text. While anything blocks the preview has no hash and no phrase; then there is no input.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an older
  one, or ''), onconfirm, oncancel.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import {
    type SubmitPreview,
    buildLine,
    canConfirmSubmit,
    checkText,
    localeLine,
    pushedText,
    releaseStatement,
    storeLabel,
    trackLine,
    versionLine,
  } from '../../lib/store-submit.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    open = $bindable(false),
    preview,
    busy,
    problem,
    notice,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    preview: SubmitPreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: (typed: string) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  let typed = $state('');

  const ready = $derived(canConfirmSubmit(preview, typed));
  const blocking = $derived(preview.checks.blocking);
  const ios = $derived(preview.app.platform === 'ios');
  const build = $derived(buildLine(preview.build));
</script>

<Modal
  bind:open
  size="lg"
  title="Submit for {storeLabel(preview.app.platform)}: confirm"
  description="{preview.app.name} · {versionLine(preview)}"
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title="Something changed">{notice}</Alert>{/if}

    <Alert tone="warn" title="This goes to the store's review and cannot be taken back from here.">
      <p class="para">{releaseStatement(preview.app.platform)}</p>
      <p class="para">{ios ? 'A submission is cancelled only in App Store Connect.' : 'A review is cancelled only in Play Console.'} It is recorded in the audit log.</p>
    </Alert>

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

    {#if preview.confirmation !== null && blocking.length === 0}
      <div class="field">
        <label for="{uid}-typed">Type <strong class="phrase">{preview.confirmation.phrase}</strong> to confirm</label>
        {#if preview.confirmation.instruction}<p class="muted small">{preview.confirmation.instruction}</p>{/if}
        <input id="{uid}-typed" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={busy} />
      </div>
    {/if}

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{blocking.length > 0 ? 'Close' : 'Cancel'}</Button>
    <Button
      variant="danger-solid"
      icon="upload"
      loading={busy}
      disabled={!ready || busy}
      onclick={() => onconfirm(typed)}
    >Submit for review</Button>
  {/snippet}
</Modal>

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

  .phrase {
    overflow-wrap: anywhere;
  }
</style>
