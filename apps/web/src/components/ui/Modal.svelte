<!--
  Modal: an accessible dialog built on the native <dialog> element. showModal() gives the focus
  trap, the inert page behind it and Escape to close; focus returns to the opener on close.
  Props: open (bindable), title, description?, size = 'sm' | 'md' | 'lg', dismissible = true
  (Escape, backdrop click and the close button; set false while a request is running),
  onclose? (called after it closes), children (body), footer? (snippet of buttons, right aligned).
  Initial focus goes to the first focusable element (the close button, or an element with
  autofocus in the body), so a destructive action never gets it by default.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    dismissible = true,
    onclose,
    children,
    footer,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg';
    dismissible?: boolean;
    onclose?: () => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Fires for Escape, a form with method="dialog", and dialog.close().
  function handleClose() {
    open = false;
    opener?.focus();
    opener = null;
    onclose?.();
  }

  function handleCancel(event: Event) {
    if (!dismissible) event.preventDefault();
  }

  // The backdrop belongs to the dialog element, so a click that lands on the dialog itself
  // (not on its content) is a click outside.
  function handleClick(event: MouseEvent) {
    if (dismissible && event.target === dialog) open = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="modal {size}"
  aria-labelledby="{uid}-title"
  aria-describedby={description ? `${uid}-desc` : undefined}
  onclose={handleClose}
  oncancel={handleCancel}
  onclick={handleClick}
>
  {#if open}
    <div class="surface">
      <header>
        <div>
          <h2 id="{uid}-title">{title}</h2>
          {#if description}<p id="{uid}-desc" class="muted">{description}</p>{/if}
        </div>
        {#if dismissible}
          <button type="button" class="ghost icon sm" aria-label="Close" onclick={() => (open = false)}>
            <Icon name="x" />
          </button>
        {/if}
      </header>
      <div class="body">{@render children()}</div>
      {#if footer}<footer>{@render footer()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  dialog.modal {
    width: calc(100% - var(--space-8));
    max-width: 480px;
    max-height: calc(100dvh - var(--space-8));
    padding: 0;
    margin: auto;
    overflow: hidden;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
  }

  dialog.modal.sm {
    max-width: 400px;
  }

  dialog.modal.lg {
    max-width: 720px;
  }

  dialog.modal[open] {
    animation: pop var(--duration-base) var(--ease);
  }

  dialog.modal::backdrop {
    background: var(--scrim);
  }

  dialog.modal[open]::backdrop {
    animation: fade var(--duration-base) var(--ease);
  }

  .surface {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - var(--space-8));
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-5) var(--space-5) 0;
  }

  header h2 {
    font-size: var(--text-lg);
  }

  header p {
    margin-top: var(--space-1);
  }

  .body {
    padding: var(--space-4) var(--space-5) var(--space-5);
    overflow: auto;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
    padding: var(--space-4) var(--space-5);
    background: var(--surface-sunken);
    border-top: 1px solid var(--line);
  }

  :global(html:has(dialog.modal[open])) {
    overflow: hidden;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
