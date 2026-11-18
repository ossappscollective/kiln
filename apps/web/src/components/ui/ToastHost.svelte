<!--
  ToastHost: shows the toasts from lib/toast.svelte.ts. Mount once, near the root of the app.
  Errors are announced at once (role="alert"); everything else politely (role="status").
  No props.
-->
<script lang="ts">
  import { toast, visibleToasts } from '../../lib/toast.svelte.ts';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  const icons: Record<string, IconName> = {
    info: 'info',
    success: 'check-circle',
    warning: 'alert-triangle',
    error: 'alert',
  };
</script>

<section class="host no-print" aria-label="Notifications">
  {#each visibleToasts() as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <span class="glyph"><Icon name={icons[t.kind] ?? 'info'} size={18} /></span>
      <div class="text">
        {#if t.title}<strong>{t.title}</strong>{/if}
        <span>{t.message}</span>
      </div>
      <button type="button" class="ghost icon sm" aria-label="Dismiss notification" onclick={() => toast.dismiss(t.id)}>
        <Icon name="x" />
      </button>
    </div>
  {/each}
</section>

<style>
  .host {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(380px, calc(100vw - var(--space-8)));
    pointer-events: none;
  }

  .toast {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
    pointer-events: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    animation: slide-in var(--duration-slow) var(--ease);
  }

  .glyph {
    display: grid;
    height: 20px;
    place-items: center;
  }

  .info .glyph {
    color: var(--info);
  }

  .success .glyph {
    color: var(--ok);
  }

  .warning .glyph {
    color: var(--warn);
  }

  .error .glyph {
    color: var(--bad);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding-top: 1px;
    overflow-wrap: anywhere;
  }

  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  @media (max-width: 480px) {
    .host {
      right: var(--space-4);
      left: var(--space-4);
      width: auto;
    }
  }
</style>
