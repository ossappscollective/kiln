<!--
  StoreReleaseDialog: the confirmation of ONE release, the one store write that cannot be taken back. App Store: the
  approved version becomes available. Google Play: the draft release starts at the share of users the person named.
  It shows who gets it, what cannot be undone in words, the checks (a blocking item removes the input; warnings are
  listed), and a typed phrase that must equal the preview's phrase exactly as the server gave it.
  It sends nothing itself: `onconfirm(typed)` is called once per click and the parent sends the preview's hash and
  the typed text. While anything blocks the preview has no hash and no phrase; then there is no input.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an older
  one, or ''), onconfirm, oncancel.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import { fullTime } from '../../../lib/format.ts';
  import { type ReleasePreview, audienceText, canConfirmRelease, releaseTitle, storeConsole } from '../../../lib/store-release.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import Modal from '../../ui/Modal.svelte';

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
    preview: ReleasePreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: (typed: string) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  let typed = $state('');

  const ready = $derived(canConfirmRelease(preview, typed));
  const blocking = $derived(preview.checks.blocking);
  const android = $derived(preview.app.platform === 'android');
  const console_ = $derived(storeConsole(preview.app.platform));
</script>

<Modal
  bind:open
  size="lg"
  title="Release: confirm"
  description="{preview.app.name} · {releaseTitle(preview)}"
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title="Something changed">{notice}</Alert>{/if}

    <Alert tone="warn" title="This reaches real users and cannot be taken back from here.">
      <p class="para">{audienceText(preview)}</p>
      <p class="para">
        {android
          ? 'A rollout is paused or changed only through the rollout controls of this app, or in Play Console.'
          : 'Pulling a released version is done only in App Store Connect.'}
        It is recorded in the audit log.
      </p>
    </Alert>

    <dl class="facts" data-testid="release-facts">
      <div><dt>App</dt><dd>{preview.app.name}</dd></div>
      {#if android}
        <div><dt>Track</dt><dd>{preview.track ?? 'Not known'}</dd></div>
        {#if preview.release}
          <div><dt>Release</dt><dd>{preview.release.name ?? 'Unnamed'} ({preview.release.status})</dd></div>
          <div><dt>Version codes</dt><dd>{preview.release.versionCodes.length > 0 ? preview.release.versionCodes.join(', ') : 'None'}</dd></div>
          <div><dt>Release notes</dt><dd>{preview.release.notes === 0 ? 'None' : `${preview.release.notes} ${preview.release.notes === 1 ? 'language' : 'languages'}`}</dd></div>
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
        <h3>Other releases of the track (read only)</h3>
        <ul class="plain">
          {#each preview.others as other (`${other.name}/${other.status}/${other.versionCodes.join(',')}`)}
            <li>
              {other.name ?? 'Unnamed'}: {other.status}{other.userFraction !== null ? ` at ${Math.round(other.userFraction * 10000) / 100}%` : ''}, codes
              {other.versionCodes.join(', ') || 'none'}
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
    <Button variant="danger-solid" icon="upload" loading={busy} disabled={!ready || busy} onclick={() => onconfirm(typed)}>Release now</Button>
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
