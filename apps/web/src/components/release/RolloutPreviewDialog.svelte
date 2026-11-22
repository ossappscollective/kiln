<!--
  RolloutPreviewDialog: the confirmation of one store rollout change: what the store shows now, what it will
  show after, the warnings of the server, and for a change that cannot be undone (release to all, release to
  100%) a typed confirmation. It sends nothing itself: `onconfirm` is called once, with the preview's hash.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an
  older one, or ''), onconfirm, oncancel.
  Layout (the publish dialog's pattern): the headline of the change first, what the store shows now and after, ONE line that it changes
  the live store (and one that it cannot be undone), the warnings of the server folded behind one line, then the confirmation.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import { foldWarnings } from '../../lib/readability.ts';
  import { t } from '../../lib/i18n/t.ts';
  import T from '../ui/T.svelte';
  import {
    IRREVERSIBLE_WARNING,
    LIVE_STORE_WARNING,
    type RolloutPreview,
    actionLabel,
    canConfirm,
    confirmPhrase,
    describeState,
  } from '../../lib/store-rollout.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Modal from '../ui/Modal.svelte';
import { byFamily } from '@kiln/core';

  let {
    open = $bindable(false),
    preview,
    busy,
    problem,
    notice,
    onconfirm,
    oncancel,
  }: {
    open?: boolean | undefined;
    preview: RolloutPreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  let typed = $state('');
  let ack = $state(false);

  const phrase = $derived(confirmPhrase(preview));
  const ready = $derived(canConfirm(preview, typed, ack));
  /** One short warning stays on its line; two or more, or a long one, sit behind one line. */
  const warnings = $derived(foldWarnings(preview.warnings));
  const storeName = $derived(byFamily(preview.app.platform, { apple: 'App Store Connect', google: 'Google Play' }));
</script>

<Modal
  bind:open
  size="lg"
  title={t('release-store:rp.title', { action: actionLabel(preview.action, preview.app.platform) })}
  description={t('release-store:rp.description', { app: preview.app.name, store: storeName })}
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title={t('release-store:ra.storeChanged')}>{notice}</Alert>{/if}

    <p class="headline" data-testid="rollout-summary">{preview.summary}</p>

    <div class="compare" aria-label={t('release-store:rp.beforeAfter')}>
      <p><span class="label">{t('release-store:rp.now')}</span> {describeState(preview.current)}</p>
      <p><span class="label">{t('release-store:rp.after')}</span> <strong>{describeState(preview.proposed)}</strong></p>
    </div>

    <p class="live">
      <T key="release-store:rp.live" params={{ warning: t(LIVE_STORE_WARNING), store: storeName, app: preview.app.name }} />
    </p>

    {#if warnings.inline.length > 0}
      <ul class="warnings">
        {#each warnings.inline as warning (warning)}<li>{warning}</li>{/each}
      </ul>
    {:else if warnings.folded.length > 0}
      <Disclosure summary={warnings.label}>
        <ul class="warnings">
          {#each warnings.folded as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Disclosure>
    {/if}

    {#if preview.irreversible}
      <p class="irreversible" role="alert"><strong>{t(IRREVERSIBLE_WARNING)}</strong></p>
      <div class="field">
        <label for="{uid}-typed"><T key="release-store:rp.type" params={{ phrase }} /></label>
        <input id="{uid}-typed" type="text" autocomplete="off" spellcheck="false" bind:value={typed} disabled={busy} />
      </div>
    {/if}

    <label class="check">
      <input type="checkbox" bind:checked={ack} disabled={busy} />
      <span>{t('release-store:rp.ack', { store: storeName })}</span>
    </label>

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="danger-solid" loading={busy} disabled={!ready || busy} onclick={onconfirm}>
      {actionLabel(preview.action, preview.app.platform)}
    </Button>
  {/snippet}
</Modal>

<style>
  .headline {
    margin: 0;
    font-size: var(--text-lg, 1.125rem);
    font-weight: var(--weight-semibold);
    line-height: 1.3;
  }

  .compare {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .compare p {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .label {
    display: block;
    font-size: 0.8125rem;
    color: var(--muted);
  }

  .live,
  .warnings {
    margin: 0;
    font-size: 0.9375rem;
  }

  .warnings {
    padding-left: var(--space-5);
  }

  .irreversible {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: 0.9375rem;
    color: var(--bad-ink);
    background: var(--bad-bg);
    border: 1px solid var(--bad-line, var(--bad));
    border-radius: var(--radius-md);
  }
</style>
