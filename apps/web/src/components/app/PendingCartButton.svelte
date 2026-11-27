<!--
  PendingCartButton: the app's pending changes, in the top bar next to the account menu (docs/adr/0054-pending-cart.md). It draws what the
  ONE state model says (docs/state-model.md, `appStateStore.topBar`), nothing it works out itself: pending (upload icon, "Pending" and the
  count), publishing (a spinner, "Publishing...", the count kept), failed (a warning icon, "Publish failed", the count kept). It shows
  when the badge is not idle, so it can never say nothing while the Overview says changes wait. Below 600px the icon and the count only.
  Pressing it opens the pending panel: the drawer of the open app for pending, the running publish for publishing, the failure block for
  failed (the open app's drawer when it covers the app, else that app's Pending page).
  The one tinted control of the top bar (ADR 0068): the `data-app-tint` marker sits on the button itself, never on the bar, so the
  accent tokens it already reads (gradient, label colour) take the open app's tint and nothing else in the bar does. `tintStyle` is
  the app's inline style (tint.style); empty (no palette, opt-out, an app without a tint) leaves the default accent. The failed state is
  the warning colour with the same label colour (`--accent-ink`, a tested pair), never the tint.
  A polite live region says "Publishing..." or "Publish failed" once when the state changes, never every few seconds.
  Props: tintStyle?, workspaceId (whose state to show).
-->
<script lang="ts">
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { openPendingPanel } from '../../lib/app-state/panel.svelte.ts';
  import { cartButton } from '../../lib/app-state/pending-facade.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Icon from '../ui/Icon.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let { tintStyle = '', workspaceId = '' }: { tintStyle?: string | undefined; workspaceId?: string | undefined } = $props();

  /** What the top bar says, from the state model (the open app's state in the page's scope, or a publish anywhere in the workspace). */
  const badge = $derived(workspaceId === '' ? ({ kind: 'idle' } as const) : appStateStore.topBar(workspaceId));
  const shown = $derived(badge.kind !== 'idle');
  const busy = $derived(badge.kind === 'publishing');
  const failed = $derived(badge.kind === 'failed');
  /** The draft was pushed and only its submit is blocked: not "Publish failed", but what to do next. */
  const blocked = $derived(badge.kind === 'failed' && badge.blocked === true);
  /** Every blocker is fixed now (a reading of the store says so): the draft can be submitted. */
  const ready = $derived(badge.kind === 'failed' && badge.ready === true);
  const count = $derived(badge.kind === 'idle' ? 0 : badge.count);
  const showCount = $derived(count > 0);
  const label = $derived(busy ? t('publish:publishing.chip') : failed ? (ready ? t('state:topBar.ready') : blocked ? t('state:topBar.blocked') : t('state:topBar.failed')) : t('app:cart.fabLabel'));

  function press() {
    if (badge.kind === 'publishing') openPendingPanel('publishing', badge.appId);
    else if (badge.kind === 'failed') openPendingPanel('failed', badge.appId);
    else cartButton.press?.();
  }
</script>

{#if shown}
  <button
    type="button"
    class="cart-button"
    class:pulse={cartButton.pulse}
    class:busy
    class:failed
    aria-haspopup={busy || failed ? undefined : 'dialog'}
    aria-expanded={busy || failed ? undefined : cartButton.expanded}
    aria-busy={busy}
    aria-label={busy ? t('publish:publishing.buttonAria') : failed ? (ready ? t('state:topBar.readyAria') : blocked ? t('state:topBar.blockedAria') : t('state:topBar.failedAria')) : t('app:cart.openAria', { count })}
    title={busy ? t('publish:publishing.buttonTitle') : failed ? (ready ? t('state:topBar.readyTitle') : blocked ? t('state:topBar.blockedTitle') : t('state:topBar.failedTitle')) : t('app:cart.buttonTitle')}
    data-testid="pending-cart-button"
    data-state={badge.kind}
    data-app-tint={tintStyle && !failed ? '' : undefined}
    style={tintStyle && !failed ? tintStyle : undefined}
    onclick={press}
  >
    {#if busy}<Spinner size={16} label="" />{:else if failed}<Icon name="alert-triangle" size={16} />{:else}<Icon name="upload" size={16} />{/if}
    <span class="label">{label}</span>
    {#if showCount}<span class="count" aria-hidden="true">{count}</span>{/if}
    <!-- read out once when a publish starts, ends or fails, never every few seconds -->
    <span class="visually-hidden" aria-live="polite" data-testid="pending-cart-live">{busy ? t('publish:publishing.chip') : failed ? (ready ? t('state:topBar.ready') : blocked ? t('state:topBar.blocked') : t('state:topBar.failed')) : ''}</span>
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

  /* Failed: the warning colour behind the same label colour (every state of the button keeps `--accent-ink` on a solid or gradient). */
  button.cart-button.failed,
  button.cart-button.failed:hover:not(:disabled),
  button.cart-button.failed:active:not(:disabled) {
    color: var(--accent-ink);
    background: linear-gradient(135deg, var(--warn), var(--warn));
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
