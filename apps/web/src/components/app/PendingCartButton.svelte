<!--
  PendingCartButton: this app's pending changes, in the top bar next to the account menu (docs/adr/0054-pending-cart.md). Compact:
  upload icon, "Pending" and the count; below 600px the icon and the count only. State comes from `cartButton` (PendingCart writes it),
  so it shows only inside an app and only while changes wait. Not the workspace-wide "Pending" page in the navigation (ADR 0064):
  its name and tooltip say "this app".
  The one tinted control of the top bar (ADR 0068): the `data-app-tint` marker sits on the button itself, never on the bar, so the
  accent tokens it already reads (gradient, label colour) take the open app's tint and nothing else in the bar does. `tintStyle` is
  the app's inline style (tint.style); empty (no palette, opt-out, an app without a tint) leaves the default accent.
  While ANY publish of the workspace runs (`publishing-store`, polled while one runs) the button shows it, wherever the person is: a spinner
  beside the icon, "Publishing…" for the label, the count kept when the open app has changes waiting, `aria-busy` and a polite live
  region. Pressing it opens the pending panel on the running publish: the open app's drawer when it covers it, else that app's Pending page,
  with the status row scrolled into view (`publishing-focus`). Props: tintStyle?, workspaceId (whose publishes to show).
-->
<script lang="ts">
  import { cartButton } from '../../lib/cart-button.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { openPublishingPanel } from '../../lib/publishing-focus.svelte.ts';
  import { appToShow } from '../../lib/publishing.ts';
  import { publishingStore } from '../../lib/publishing-store.svelte.ts';
  import Icon from '../ui/Icon.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let { tintStyle = '', workspaceId = '' }: { tintStyle?: string | undefined; workspaceId?: string | undefined } = $props();

  /** The apps of the workspace that publish right now (the shared store; empty while none does). */
  const running = $derived(workspaceId === '' ? [] : publishingStore.ids(workspaceId));
  const busy = $derived(running.length > 0);
  /** Shown while changes wait in the open app, and also while any publish runs (the open app may have nothing waiting). */
  const shown = $derived(cartButton.visible || busy);
  const showCount = $derived(cartButton.visible);

  function press() {
    const id = appToShow(running, cartButton.appIds);
    if (busy && id !== null) openPublishingPanel(id);
    else cartButton.press?.();
  }
</script>

{#if shown}
  <button
    type="button"
    class="cart-button"
    class:pulse={cartButton.pulse}
    class:busy
    aria-haspopup={busy ? undefined : 'dialog'}
    aria-expanded={busy ? undefined : cartButton.expanded}
    aria-busy={busy}
    aria-label={busy ? t('publish:publishing.buttonAria') : t('app:cart.openAria', { count: cartButton.count })}
    title={busy ? t('publish:publishing.buttonTitle') : t('app:cart.buttonTitle')}
    data-testid="pending-cart-button"
    data-app-tint={tintStyle ? '' : undefined}
    style={tintStyle || undefined}
    onclick={press}
  >
    {#if busy}<Spinner size={16} label="" />{:else}<Icon name="upload" size={16} />{/if}
    <span class="label">{busy ? t('publish:publishing.chip') : t('app:cart.fabLabel')}</span>
    {#if showCount}<span class="count" aria-hidden="true">{cartButton.count}</span>{/if}
    <!-- read out once when a publish starts or ends, never every few seconds -->
    <span class="visually-hidden" aria-live="polite" data-testid="pending-cart-live">{busy ? t('publish:publishing.chip') : ''}</span>
  </button>
{/if}

<style>
  /*
    Every rule is written as `button.cart-button...`: the global `button:hover:not(:disabled)` (app.css) has the specificity of
    (0,2,1) and a plain scoped `.cart-button` rule loses to it, which painted the hovered button with --surface-hover (white) under
    the white label: only the count chip stayed visible. Same trap as FilterChip. Colours of the label and the icon are
    --accent-ink on the gradient in EVERY state (a tested pair), and no state may use a surface background.
  */
  button.cart-button {
    display: inline-flex;
    flex-shrink: 0;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--accent-ink);
    cursor: pointer;
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    border: 0;
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-sm);
    transition:
      transform var(--duration-fast) var(--ease),
      filter var(--duration-fast) var(--ease),
      box-shadow var(--duration-fast) var(--ease);
  }

  /* Hover: the same gradient a little brighter and lifted; colour, icon and label do not change. */
  button.cart-button:hover:not(:disabled) {
    color: var(--accent-ink);
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    filter: brightness(1.08);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }

  button.cart-button:focus-visible {
    outline: var(--ring);
    outline-offset: 2px;
    box-shadow: var(--shadow-sm), var(--halo);
  }

  /* Pressed (and open: the drawer it controls is showing): pushed back down, a touch darker. */
  button.cart-button:active:not(:disabled),
  button.cart-button[aria-expanded='true'] {
    color: var(--accent-ink);
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    filter: brightness(0.94);
    transform: translateY(0);
    box-shadow: var(--shadow-sm);
  }

  button.cart-button:disabled {
    color: var(--accent-ink);
    cursor: not-allowed;
    filter: saturate(0.5);
    opacity: 0.6;
    box-shadow: var(--shadow-sm);
  }

  /* The ring on the gradient: the label colour, not the page's grey and blue. */
  button.cart-button :global(.spinner) {
    border-color: color-mix(in srgb, var(--accent-ink) 35%, transparent);
    border-top-color: var(--accent-ink);
  }

  button.cart-button.busy {
    cursor: progress;
  }

  .count {
    display: inline-grid;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 var(--space-1);
    place-items: center;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--app-accent-ink, var(--ink));
    background: var(--surface);
    border-radius: var(--radius-full);
  }

  button.cart-button.pulse {
    animation: cart-pulse 700ms var(--ease);
  }

  @keyframes cart-pulse {
    40% {
      transform: scale(1.12);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    button.cart-button {
      transition: none;
    }

    button.cart-button:hover:not(:disabled) {
      transform: none;
    }

    button.cart-button.pulse {
      animation: none;
    }
  }

  @media (max-width: 599px) {
    .label {
      display: none;
    }

    button.cart-button {
      padding: 0 var(--space-2);
    }
  }
</style>
