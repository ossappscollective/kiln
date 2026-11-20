<!--
  SaveBar: the one save bar of a form in the app Settings (the same pattern as the workspace Settings page): it says "You have unsaved
  changes." or "All changes are saved." and holds the one primary Save and a quiet Discard. It stays at the bottom of the visible part,
  so a long form never hides it. `type="submit"` for a bar inside a <form>, else `onsave` runs on the click.
  Props: dirty, saving, disabled? (the person may not edit: nothing is drawn as an action), onsave?, ondiscard, type? = 'button',
  saveLabel? = 'Save', discardLabel? = 'Discard changes', note? (a short snippet at the end, for example why Save is off).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { saveBarText } from '../../../lib/app-settings.ts';
  import Button from '../../ui/Button.svelte';

  let {
    dirty,
    saving = false,
    disabled = false,
    type = 'button',
    saveLabel = 'Save',
    discardLabel = 'Discard changes',
    onsave,
    ondiscard,
    note,
  }: {
    dirty: boolean;
    saving?: boolean | undefined;
    disabled?: boolean | undefined;
    type?: 'button' | 'submit' | undefined;
    saveLabel?: string | undefined;
    discardLabel?: string | undefined;
    onsave?: (() => void) | undefined;
    ondiscard: () => void;
    note?: Snippet | undefined;
  } = $props();
</script>

<div class="savebar" class:pending={dirty}>
  <p class="state" role="status">{saveBarText(dirty, saving)}</p>
  {#if note}<span class="note">{@render note()}</span>{/if}
  <div class="row">
    <Button disabled={disabled || !dirty || saving} onclick={ondiscard}>{discardLabel}</Button>
    <Button {type} variant="primary" loading={saving} disabled={disabled || !dirty || saving} onclick={type === 'button' ? onsave : undefined}>{saveLabel}</Button>
  </div>
</div>

<style>
  .savebar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 8%));
  }

  .savebar.pending {
    border-color: var(--accent, var(--line));
  }

  .state {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .pending .state {
    color: var(--ink);
  }

  .note {
    flex: 1 1 12rem;
    font-size: 0.9375rem;
    color: var(--muted);
  }
</style>
