<script lang="ts">
  import { type CredentialKind, credentialKindInfo } from '@kiln/core';

  let {
    kind,
    values = $bindable({}),
    disabled = false,
    idPrefix = 'secret',
  }: {
    kind: CredentialKind;
    values?: Record<string, string> | undefined;
    disabled?: boolean | undefined;
    idPrefix?: string | undefined;
  } = $props();

  const MAX_FILE = 64 * 1024;
  let fileError = $state('');

  async function load(name: string, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    fileError = '';
    if (!file) return;
    if (file.size > MAX_FILE) {
      fileError = 'That file is too large to be a key.';
    } else {
      values[name] = await file.text();
    }
    // Do not keep the file selection around. The text is in the field.
    input.value = '';
  }
</script>

{#each credentialKindInfo[kind].fields as field (field.name)}
  <div class="field">
    <label for="{idPrefix}-{field.name}">{field.label}</label>
    {#if field.multiline}
      <textarea
        id="{idPrefix}-{field.name}"
        bind:value={values[field.name]}
        {disabled}
        autocomplete="off"
        spellcheck="false"
        placeholder={field.accept ? 'Paste the contents, or load from a file' : ''}
      ></textarea>
      <p class="hint">
        <label class="file">
          Load from a file
          <input
            class="visually-hidden"
            type="file"
            accept={field.accept}
            {disabled}
            onchange={(e) => load(field.name, e)}
          />
        </label>
      </p>
    {:else}
      {#if field.secret}
        <input
          id="{idPrefix}-{field.name}"
          type="password"
          bind:value={values[field.name]}
          {disabled}
          autocomplete="off"
          spellcheck="false"
        />
      {:else}
        <input
          id="{idPrefix}-{field.name}"
          bind:value={values[field.name]}
          {disabled}
          autocomplete="off"
          spellcheck="false"
        />
      {/if}
      {#if field.hint}<p class="hint">{field.hint}</p>{/if}
    {/if}
  </div>
{/each}
{#if fileError}<p class="alert error" role="alert">{fileError}</p>{/if}

<style>
  label.file {
    display: inline;
    margin: 0;
    font-weight: 500;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  label.file:focus-within {
    outline: var(--ring);
  }
</style>
