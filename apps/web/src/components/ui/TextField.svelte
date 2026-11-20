<!--
  TextField: a label, an input, helper text and an inline error, wired together for assistive
  technology (aria-describedby, aria-invalid).
  Props: label, value (bindable), type = 'text', hint?, error? (a message; sets aria-invalid),
  reveal (password only: adds a show/hide button), id? (generated when missing), and any input
  attribute (autocomplete, required, minlength, placeholder, onblur, ...).
  The error replaces nothing: the hint stays so the rule is still visible.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';

  type Props = Omit<HTMLInputAttributes, 'value' | 'class' | 'children'> & {
    label: string;
    value?: string | undefined;
    hint?: string | undefined;
    error?: string | undefined;
    reveal?: boolean | undefined;
  };

  let {
    label,
    value = $bindable(''),
    type = 'text',
    hint,
    error,
    reveal = false,
    id: idProp,
    ...rest
  }: Props = $props();

  const uid = $props.id();
  const id = $derived(idProp ?? `${uid}-input`);
  let shown = $state(false);
  const describedBy = $derived([hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined);
  const inputType = $derived(reveal && type === 'password' && shown ? 'text' : type);
</script>

<div class="field">
  <label for={id} class:required={rest.required}>{label}</label>
  <div class:input-group={reveal}>
    <input {...rest} {id} type={inputType} bind:value aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} />
    {#if reveal}
      <button
        type="button"
        class="ghost icon sm"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onclick={() => (shown = !shown)}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} />
      </button>
    {/if}
  </div>
  {#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
  {#if error}
    <p class="field-error" id="{id}-error">
      <Icon name="alert" size={14} class="field-error-icon" />
      <span>{error}</span>
    </p>
  {/if}
</div>
