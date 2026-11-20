<!--
  EasStatusNote: one quiet line above the build list when the app is linked to an Expo project: how fresh the EAS builds are, what went wrong
  when Expo could not be read, and a link to the project on Expo. READ ONLY: it changes nothing at Expo.
  Props: status (the stored EAS status of the app), problem (a sentence when a read from this page failed, else ''), now.
-->
<script lang="ts">
  import { type EasStatusView, easSyncLine } from '../../lib/eas/eas-status.ts';
  import Icon from '../ui/Icon.svelte';

  let { status, problem, now }: { status: EasStatusView; problem: string; now: number } = $props();

  const line = $derived(easSyncLine(status, now));
  const tone = $derived(problem ? 'warn' : (line?.tone ?? 'info'));
</script>

{#if status.project}
  <div class="note {tone}" role={problem ? 'alert' : 'status'} data-testid="eas-status-note">
    <Icon name={tone === 'warn' ? 'alert-triangle' : 'info'} size={16} />
    <span class="text">{problem || line?.text || ''}</span>
    <a href={status.project.url} target="_blank" rel="noopener noreferrer">{status.project.fullName} on Expo<Icon name="external-link" size={12} /><span class="visually-hidden"> (opens in a new tab)</span></a>
  </div>
{/if}

<style>
  .note {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--info-ink);
    background: var(--info-bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .note.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
  }

  .text {
    flex: 1 1 14rem;
    min-width: 0;
  }

  a {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: inherit;
  }
</style>
