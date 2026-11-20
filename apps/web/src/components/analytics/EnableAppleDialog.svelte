<!--
  EnableAppleDialog: "Enable Apple analytics", the one store write of analytics, in two steps that are never shortened.
  1. Preview (GET apple/enable): reads your App Store Connect account and changes nothing. It lists exactly what exists at Apple
     and what would be created, in words and as the lines the server would send.
  2. Confirmation: a ticked box and the word "enable" typed exactly. Only then POST apple/enable is sent, once, with the hash of the
     preview. If what Apple has changed meanwhile (plan_changed), nothing was sent: the new plan is shown and must be confirmed again.
  When the key's role may not create report requests the dialog says so and offers "Import a report file" instead.
  Props: open (bindable), api, workspaceId, appId, onenabled (called after the request exists), onimport (open the file import).
  Readable pass (docs/design/readability.md): 15px text; both sections stay visible (this is a write to Apple), the plan's notes fold
  behind one line, the acknowledgement is the one warning beside the action. Preview, hash, phrase and send are unchanged.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { type EnablePreview, analyticsErrorText } from '../../lib/analytics.ts';
  import { ENABLE_PHRASE, canConfirmEnable, classifyEnableError, describeStep, enableDecision } from '../../lib/analytics-import.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import '../readable-card.css';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    onenabled,
    onimport,
  }: { open?: boolean; api: Api; workspaceId: string; appId: string; onenabled: () => void; onimport?: () => void } = $props();

  const uid = $props.id();
  let preview = $state<EnablePreview | null>(null);
  let loading = $state(false);
  let sending = $state(false);
  let backfill = $state(false);
  let acknowledged = $state(false);
  let typed = $state('');
  let loadError = $state('');
  let sendError = $state('');
  let changed = $state(false);
  let generation = 0;

  const decision = $derived(preview ? enableDecision(preview) : null);
  const ready = $derived(canConfirmEnable(preview, acknowledged, typed));

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = '';
    try {
      const next = await api.previewAppleEnable(workspaceId, appId, backfill);
      if (mine !== generation) return;
      preview = next;
    } catch (e) {
      if (mine !== generation) return;
      preview = null;
      loadError = analyticsErrorText(e);
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // Opening starts clean and reads the preview once. Nothing carries over from an earlier opening.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      preview = null;
      backfill = false;
      acknowledged = false;
      typed = '';
      sendError = '';
      loadError = '';
      changed = false;
      void load();
    });
  });

  function toggleBackfill(next: boolean) {
    backfill = next;
    acknowledged = false;
    typed = '';
    sendError = '';
    void load();
  }

  async function enable() {
    if (!preview || !ready || sending) return;
    sending = true;
    sendError = '';
    changed = false;
    try {
      const hash = preview.confirmHash;
      await confirmed((grant) => api.enableApple(workspaceId, appId, { confirmHash: hash, ...(backfill ? { backfill: true } : {}) }, grant), hash);
      open = false;
      toast.success('Apple analytics is enabled. The first reports take one to two days.');
      onenabled();
    } catch (e) {
      const failure = classifyEnableError(e);
      acknowledged = false;
      typed = '';
      if (failure.kind === 'plan_changed') {
        // Nothing was sent. The new plan has to be read and confirmed again.
        changed = true;
        if (failure.preview) preview = failure.preview;
        else void load();
      } else if (failure.kind === 'role_required') {
        sendError = failure.message;
        if (preview) preview = { ...preview, canCreate: false, plan: { ...preview.plan, roleCheck: 'role_required' } };
      } else {
        sendError = failure.message;
      }
    } finally {
      sending = false;
    }
  }

  function importInstead() {
    open = false;
    onimport?.();
  }
</script>

<Modal bind:open size="lg" title="Enable Apple analytics" description="Apple makes analytics reports only after a report request exists for the app." dismissible={!sending}>
  <div class="stack readable-card">
    {#if loading && !preview}
      <div role="status" aria-label="Reading what exists at Apple"><Skeleton width="70%" height="16px" /><Skeleton width="50%" height="16px" /></div>
    {:else if loadError}
      <Alert tone="error">{loadError}</Alert>
      <div class="row"><Button onclick={load}>Try again</Button></div>
    {:else if preview && decision}
      <p class="muted read">This preview read your App Store Connect account and changed nothing.</p>

      {#if changed}
        <Alert tone="warn" title="The plan changed">What exists at Apple changed since you opened this. Nothing was sent. Read the plan below and confirm again.</Alert>
      {/if}

      {#if decision.kind === 'import_instead'}
        <Alert tone="warn" title="This key cannot create report requests">
          Apple lists the Admin role for creating them. Use a key with the Admin role once, or import a report file you download from App Store Connect.
        </Alert>
      {:else if decision.kind === 'nothing'}
        <Alert tone="ok" title="Already enabled">The report request is already in place. Nothing would be created.</Alert>
      {/if}

      <section aria-labelledby="{uid}-steps">
        <h3 id="{uid}-steps" class="h">What would happen</h3>
        <ol class="steps">
          {#each preview.plan.steps as step (step.accessType)}
            <li>{describeStep(step)}</li>
          {/each}
        </ol>
      </section>

      <section aria-labelledby="{uid}-send">
        <h3 id="{uid}-send" class="h">Exactly what will be sent to Apple</h3>
        {#if preview.plan.willSend.length > 0}
          <ul class="send">
            {#each preview.plan.willSend as line (line)}<li>{line}</li>{/each}
          </ul>
        {:else}
          <p class="muted">Nothing will be sent to Apple.</p>
        {/if}
      </section>

      {#if preview.plan.notes.length > 0}
        <Disclosure summary={preview.plan.notes.length === 1 ? 'A note about this plan' : `${preview.plan.notes.length} notes about this plan`}>
          <ul class="notes muted">
            {#each preview.plan.notes as note (note)}<li>{note}</li>{/each}
          </ul>
        </Disclosure>
      {/if}

      {#if decision.kind === 'confirm'}
        <label class="check">
          <input type="checkbox" checked={backfill} disabled={sending || loading} onchange={(e) => toggleBackfill(e.currentTarget.checked)} />
          Also request history since 2024-01-01 (a one-time snapshot; Apple allows one a month)
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={acknowledged} disabled={sending || loading} />
          I understand this creates a report request in my App Store Connect account.
        </label>
        <div class="field">
          <label for="{uid}-typed">Type <strong class="phrase">{ENABLE_PHRASE}</strong> to confirm</label>
          <input id="{uid}-typed" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={sending || loading} />
        </div>
      {/if}

      {#if sendError}<Alert tone="error">{sendError}</Alert>{/if}
    {/if}
  </div>
  {#snippet footer()}
    <Button disabled={sending} onclick={() => (open = false)}>Cancel</Button>
    {#if decision?.kind === 'import_instead' && onimport}
      <Button variant="primary" icon="upload" onclick={importInstead}>Import a report file</Button>
    {:else if decision?.kind === 'confirm'}
      <Button variant="primary" loading={sending} disabled={!ready || sending || loading} onclick={enable}>Create the request at Apple</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .read {
    margin: 0;
  }

  .h {
    margin: 0 0 var(--space-2);
    font-size: 1rem;
    font-weight: var(--weight-semibold);
  }

  .steps,
  .send,
  .notes {
    padding-left: var(--space-5);
    margin: 0;
  }

  .send li {
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }

  .steps li + li,
  .send li + li,
  .notes li + li {
    margin-top: var(--space-1);
  }

  .phrase {
    font-family: var(--font-mono);
  }
</style>
