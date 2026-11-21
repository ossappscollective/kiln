<!--
  StoreReleaseDialog: the confirmation of ONE release, the one store write that cannot be taken back. App Store: the
  approved version becomes available. Google Play: the draft release starts at the share of users the person named.
  It shows who gets it, what cannot be undone in words, the checks (a blocking item removes the input; warnings are
  listed), and a typed phrase that must equal the preview's phrase exactly as the server gave it.
  It sends nothing itself: `onconfirm(typed)` is called once per click and the parent sends the preview's hash and
  the typed text. While anything blocks the preview has no hash and no phrase; then there is no input.
  Google Play: "Check this release" (PlayCheck) sits under the preview, for the release the store holds at the share named in the
  preview: local checks and "Check with Google Play" (errors only, nothing saved). It is optional and never gates the release.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an older
  one, or ''), onconfirm, oncancel, api and workspaceId (needed for the Google Play check; without them it is not drawn).
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import type { Api } from '../../../lib/api.ts';
  import { type ReleasePreview, audienceText, canConfirmRelease, releaseTitle } from '../../../lib/store-release.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import Modal from '../../ui/Modal.svelte';
  import ReleasePreviewBody from '../../publish/ReleasePreviewBody.svelte';
  import PlayCheck from './PlayCheck.svelte';
import { supports } from '@kiln/core';

  let {
    open = $bindable(false),
    preview,
    busy,
    problem,
    notice,
    onconfirm,
    oncancel,
    api,
    workspaceId,
  }: {
    open?: boolean | undefined;
    preview: ReleasePreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: (typed: string) => void;
    oncancel: () => void;
    api?: Api | undefined;
    workspaceId?: string | undefined;
  } = $props();

  const uid = $props.id();
  let typed = $state('');

  const ready = $derived(canConfirmRelease(preview, typed));
  const blocking = $derived(preview.checks.blocking);
  const android = $derived(supports(preview.app.platform, 'releaseTracks'));
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

    <ReleasePreviewBody {preview} />

    {#if android && api && workspaceId && preview.track}
      <PlayCheck
        {api}
        {workspaceId}
        app={preview.app}
        track={preview.track}
        codes={preview.release ? preview.release.versionCodes : (preview.request.versionCodes ?? [])}
        fraction={preview.audience.userFraction ?? preview.request.userFraction ?? null}
        source="store"
      />
    {/if}

    {#if preview.confirmation !== null && preview.confirmationRequired !== false && blocking.length === 0}
      <div class="field">
        <label for="{uid}-typed">Type <strong class="phrase">{preview.confirmation.phrase}</strong> to confirm</label>
        {#if preview.confirmation.instruction}<p class="muted small">{preview.confirmation.instruction}</p>{/if}
        <input id="{uid}-typed" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={busy} />
      </div>
    {/if}

    {#if preview.confirmationRequired === false && preview.confirmation !== null && blocking.length === 0}
      <p class="muted small" data-testid="confirm-by-step-up">You will be asked for your password or passkey to confirm. Nothing needs typing.</p>
    {/if}

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{blocking.length > 0 ? 'Close' : 'Cancel'}</Button>
    <Button variant="danger-solid" icon="upload" loading={busy} disabled={!ready || busy} onclick={() => onconfirm(typed)}>Release now</Button>
  {/snippet}
</Modal>

<style>
  .para {
    margin: var(--space-1) 0 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .phrase {
    overflow-wrap: anywhere;
  }
</style>
