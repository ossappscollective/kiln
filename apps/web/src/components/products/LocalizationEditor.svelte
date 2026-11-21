<!--
  LocalizationEditor: the display name and description of ONE product in ONE language, the only thing of a product that can be changed from
  here (docs/api/products.md, docs/adr/0034-in-app-products.md). Prices, availability and the product itself are read only.
  The flow is the safe one of every store write: edit, "Preview change" (reads the store, writes nothing), then "Apply to <store>" once, with the
  hash of that preview, inside `confirmed(...)` so a workspace that covers the action with a step-up asks for the person's confirmation. The
  preview is shown read only: what is applied is exactly what was previewed. If the store changed meanwhile, nothing is overwritten and the
  preview is read again. Never retried by this app.
  Disabled states: a role below admin sees the texts read only with the reason; while the server's switch is off the texts are read only and
  the page names MRM_STORE_PRODUCT_WRITE_ENABLED. Read only means plain text for every language, never disabled inputs.
  Props: api, workspaceId, role, app ({ id, platform }), product (the detail), writeEnabled (the server's switch, from the list), onsaved
  (the texts were changed: read the product and the list again), onswitchoff (the server said the switch is off).
-->
<script lang="ts">
  import { can, type Role } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import {
    changeSummary,
    classifyProductFailure,
    MAX_PRODUCT_DESCRIPTION,
    MAX_PRODUCT_NAME,
    PRODUCT_WRITE_ENV,
    PRODUCT_WRITE_ROLE_REASON,
    textsDiffer,
    validateTexts,
  } from '../../lib/products.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ProductDetail, ProductLocalizationPreview } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    product,
    writeEnabled,
    onsaved,
    onswitchoff,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform'>;
    product: ProductDetail;
    writeEnabled: boolean;
    onsaved: () => void;
    onswitchoff: () => void;
  } = $props();

  const uid = $props.id();
  const storeName = $derived(storeForPlatform(app.platform).fullLabel);
  const mayWrite = $derived(can(role, 'monetization.write'));
  const editable = $derived(mayWrite && writeEnabled);

  let locale = $state('');
  let name = $state('');
  let description = $state('');
  let phase = $state<'edit' | 'previewing' | 'preview' | 'applying'>('edit');
  let preview = $state<ProductLocalizationPreview | null>(null);
  let problem = $state('');
  let announcement = $state('');
  let touched = $state(false);

  const stored = $derived(product.localizations.find((l) => l.locale === locale) ?? null);
  const problems = $derived(validateTexts(name, description));
  const invalid = $derived(problems.name !== undefined || problems.description !== undefined);
  const changed = $derived(stored !== null && textsDiffer({ name, description }, stored));
  const busy = $derived(phase === 'previewing' || phase === 'applying');

  // A different product starts on its first language (en-US when it has one); a different language, or the stored texts changing (a
  // sync, a change made here), start from what is stored, unless the person has typed something that is not yet applied.
  $effect(() => {
    const id = product.productId;
    void id;
    const wanted =
      product.localizations.find((l) => l.locale === locale)?.locale ??
      product.localizations.find((l) => l.locale.toLowerCase() === 'en-us')?.locale ??
      product.localizations[0]?.locale ??
      '';
    if (wanted !== locale) {
      locale = wanted;
      touched = false;
    }
  });
  $effect(() => {
    const current = stored;
    if (touched || current === null) return;
    name = current.name;
    description = current.description;
    preview = null;
    phase = 'edit';
  });

  function chooseLocale(next: string) {
    if (busy) return;
    locale = next;
    touched = false;
    preview = null;
    problem = '';
    phase = 'edit';
    const current = product.localizations.find((l) => l.locale === next);
    name = current?.name ?? '';
    description = current?.description ?? '';
  }

  function resetDraft() {
    touched = false;
    preview = null;
    problem = '';
    phase = 'edit';
    name = stored?.name ?? '';
    description = stored?.description ?? '';
  }

  function say(text: string) {
    problem = text;
    announcement = text;
  }

  async function runPreview(keep: string | null = null) {
    if (busy || !editable || invalid) return;
    phase = 'previewing';
    problem = keep ?? '';
    try {
      const read = await api.previewProductLocalization(workspaceId, app.id, product.productId, locale, { name, description });
      preview = read.preview;
      phase = 'preview';
      announcement = changeSummary(read.preview);
    } catch (e) {
      const failure = classifyProductFailure(e, 'read');
      if (failure.kind === 'disabled') onswitchoff();
      say(failure.message);
      preview = null;
      phase = 'edit';
    }
  }

  async function apply() {
    const shown = preview;
    if (shown === null || busy || !editable || shown.unchanged) return;
    phase = 'applying';
    problem = '';
    const body = { name: shown.proposed.name, description: shown.proposed.description, previewHash: shown.previewHash };
    try {
      // The only call that writes to the store. Sent once per click, with the hash of the preview, exactly the texts that were previewed.
      const done = await confirmed((grant) => api.applyProductLocalization(workspaceId, app.id, product.productId, shown.locale, body, grant), body.previewHash);
      const text = done.result.confirmedByReread
        ? `The ${shown.locale} texts were changed in ${storeName} (the answer was lost, and reading the store back confirmed it).`
        : `The ${shown.locale} texts were changed in ${storeName}.`;
      toast.success(text);
      announcement = text;
      touched = false;
      preview = null;
      phase = 'edit';
      name = done.result.after.name;
      description = done.result.after.description;
      onsaved();
    } catch (e) {
      const failure = classifyProductFailure(e, 'change');
      if (failure.kind === 'disabled') onswitchoff();
      phase = 'edit';
      preview = null;
      if (failure.kind === 'state_changed') {
        // Nothing was written. Read the store again so the person sees what is there now and can apply that.
        say(`${failure.message} The preview below is read again.`);
        await runPreview(`${failure.message} The preview below is read again.`);
      } else {
        say(failure.message);
      }
    }
  }
</script>

<div class="stack" data-testid="localization-editor">
  {#if !mayWrite}
    <Alert tone="info" title="You can read these texts, not change them">{PRODUCT_WRITE_ROLE_REASON}</Alert>
  {:else if !writeEnabled}
    <Alert tone="info" title="Changing texts is switched off on this server">
      Someone who runs the server sets <code>{PRODUCT_WRITE_ENV}=true</code> and restarts it. Until then the texts are read only.
    </Alert>
  {/if}

  {#if product.localizations.length === 0}
    <p class="muted text-sm">The store has no texts for this product. Add a language in the store's console, then sync the app.</p>
  {:else if !editable}
    <!-- Nothing can be changed (the role, or the server's switch): the texts are shown as text, not as inputs that look editable. -->
    <dl class="texts" data-testid="localization-readonly">
      {#each product.localizations as l (l.locale)}
        <div class="text-block">
          <dt><span class="mono">{l.locale}</span></dt>
          <dd class="text-name">{l.name === '' ? 'No display name' : l.name}</dd>
          <dd class="desc muted">{l.description === '' ? 'No description' : l.description}</dd>
        </div>
      {/each}
    </dl>
  {:else}
    <div class="field locale">
      <label for="{uid}-locale">Language</label>
      <select id="{uid}-locale" value={locale} disabled={busy} onchange={(event) => chooseLocale(event.currentTarget.value)}>
        {#each product.localizations as l (l.locale)}
          <option value={l.locale}>{l.locale}</option>
        {/each}
      </select>
      <p class="hint">Adding a language is not built: add it in the store's console, then sync.</p>
    </div>

    {#if (phase === 'preview' || phase === 'applying') && preview}
      <section class="preview" aria-label="Preview of the change" data-testid="localization-preview">
        <p class="summary"><strong>{changeSummary(preview)}</strong></p>
        <div class="compare">
          <div>
            <h4>In {storeName} now</h4>
            <dl>
              <dt>Display name</dt>
              <dd>{preview.current.name}</dd>
              <dt>Description</dt>
              <dd class="desc">{preview.current.description === '' ? 'Empty' : preview.current.description}</dd>
            </dl>
          </div>
          <div>
            <h4>After the change</h4>
            <dl>
              <dt>Display name {#if preview.changes.name}<Badge tone="info">Changed</Badge>{/if}</dt>
              <dd>{preview.proposed.name}</dd>
              <dt>Description {#if preview.changes.description}<Badge tone="info">Changed</Badge>{/if}</dt>
              <dd class="desc">{preview.proposed.description === '' ? 'Empty' : preview.proposed.description}</dd>
            </dl>
          </div>
        </div>
        {#each preview.warnings as warning (warning)}
          <p class="muted text-sm">{warning}</p>
        {/each}
        {#if preview.unchanged}
          <Alert tone="info">{storeName} already shows these texts. There is nothing to apply.</Alert>
        {/if}
        <div class="row actions">
          <Button onclick={() => (phase = 'edit')} disabled={busy}>Back to editing</Button>
          <span class="spacer"></span>
          <Button variant="primary" loading={phase === 'applying'} disabled={!editable || preview.unchanged} onclick={() => void apply()}>
            Apply to {storeName}
          </Button>
        </div>
      </section>
    {:else}
      <form
        class="stack"
        onsubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <TextField
          label="Display name"
          bind:value={name}
          oninput={() => (touched = true)}
          readonly={!editable}
          disabled={phase === 'previewing'}
          autocomplete="off"
          maxlength={MAX_PRODUCT_NAME + 50}
          error={touched ? problems.name : undefined}
          hint="What customers see as the name of this product."
        />
        <div class="field">
          <label for="{uid}-description">Description</label>
          <textarea
            id="{uid}-description"
            rows="4"
            bind:value={description}
            oninput={() => (touched = true)}
            readonly={!editable}
            disabled={phase === 'previewing'}
            maxlength={MAX_PRODUCT_DESCRIPTION + 200}
            aria-invalid={touched && problems.description ? 'true' : undefined}
            aria-describedby="{uid}-description-hint"
          ></textarea>
          <p id="{uid}-description-hint" class="hint">{description.length} of {MAX_PRODUCT_DESCRIPTION} characters. The store may have a shorter limit and says so if it refuses.</p>
          {#if touched && problems.description}<p class="field-error" role="alert">{problems.description}</p>{/if}
        </div>
        <div class="row actions">
          {#if changed}<Button onclick={resetDraft} disabled={busy}>Discard changes</Button>{/if}
          <span class="spacer"></span>
          <Button type="submit" variant="primary" loading={phase === 'previewing'} disabled={!editable || !changed || invalid}>Preview change</Button>
        </div>
        {#if editable && !changed}<p class="muted text-sm">Change the name or the description to preview the change. Nothing is sent to {storeName} until you apply it.</p>{/if}
      </form>
    {/if}
  {/if}

  {#if problem !== ''}<Alert tone="error">{problem}</Alert>{/if}
  <p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
  .locale select {
    max-width: 16rem;
  }

  .preview {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }

  .summary {
    margin: 0;
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-4);
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--muted);
    font-weight: 500;
  }

  dl {
    margin: 0;
    display: grid;
    gap: var(--space-1);
  }

  dt {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  dd {
    margin: 0 0 var(--space-2);
    overflow-wrap: anywhere;
  }

  .desc {
    white-space: pre-wrap;
  }

  .texts {
    display: grid;
    gap: var(--space-3);
  }

  .text-block {
    display: grid;
    gap: var(--space-1);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--line);
  }

  .text-block:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .text-block dd {
    margin: 0;
  }

  .text-name {
    font-weight: 500;
  }

  .actions {
    align-items: center;
  }
</style>
