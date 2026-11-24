<!--
  PendingCartButton: this app's pending changes, in the top bar next to the account menu (docs/adr/0054-pending-cart.md). Compact:
  upload icon, "Pending" and the count; below 600px the icon and the count only. State comes from `cartButton` (PendingCart writes it),
  so it shows only inside an app and only while changes wait. Not the workspace-wide "Pending" page in the navigation (ADR 0064):
  its name and tooltip say "this app".
-->
<script lang="ts">
  import { cartButton } from '../../lib/cart-button.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Icon from '../ui/Icon.svelte';
</script>

{#if cartButton.visible}
  <button
    type="button"
    class="cart-button"
    class:pulse={cartButton.pulse}
    aria-haspopup="dialog"
    aria-expanded={cartButton.expanded}
    aria-label={t('app:cart.openAria', { count: cartButton.count })}
    title={t('app:cart.buttonTitle')}
    data-testid="pending-cart-button"
    onclick={() => cartButton.press?.()}
  >
    <Icon name="upload" size={16} />
    <span class="label">{t('app:cart.fabLabel')}</span>
    <span class="count" aria-hidden="true">{cartButton.count}</span>
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

  .count {
    display: inline-grid;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 var(--space-1);
    place-items: center;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
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
