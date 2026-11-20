<!--
  CompetitorCard: one followed competitor: its name, version, rating (and how many ratings), price and a line about
  the last change. "Compare" puts it in the side by side table; the change history (a diff list of what changed and
  when) is collapsed. Everything a competitor wrote (name, subtitle) is plain text.
  Props: competitor, history (or null while it loads), now, canWrite, comparing, ontoggle, onremove, showStore.
-->
<script lang="ts">
  import { type AsoCompetitor, type AsoCompetitorHistory, changeText, countText, lastChangeText, ratingText } from '../../lib/aso.ts';
  import { timeAgo } from '../../lib/format.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    competitor,
    history,
    now,
    canWrite,
    comparing,
    ontoggle,
    onremove,
    busy = false,
  }: {
    competitor: AsoCompetitor;
    history: AsoCompetitorHistory | null;
    now: number;
    canWrite: boolean;
    comparing: boolean;
    ontoggle: () => void;
    onremove: () => void;
    busy?: boolean;
  } = $props();

  const uid = $props.id();
  const latest = $derived(competitor.latest);
  const changes = $derived((history?.snapshots ?? []).filter((s) => s.changes !== null && s.changes.length > 0));
  let confirming = $state(false);
</script>

<article class="card competitor" aria-labelledby="{uid}-name">
  <header class="head">
    <h3 id="{uid}-name" class="name truncate" title={competitor.name}>{competitor.name}</h3>
    {#if competitor.state === 'not_found'}
      <Badge tone="warn" icon="alert-triangle">Not in the store</Badge>
    {:else if competitor.state === 'unavailable'}
      <Badge tone="warn" icon="alert-triangle">Could not be read</Badge>
      <InfoTip label="Why it could not be read" text="The last look at the store failed{competitor.error ? ` (${competitor.error})` : ''}. What is shown is from the last successful look." />
    {/if}
  </header>
  {#if latest?.subtitle}<p class="sub muted truncate" title={latest.subtitle}>{latest.subtitle}</p>{/if}

  <dl class="facts">
    <div><dt>Version</dt><dd>{latest?.version ?? '–'}</dd></div>
    <div>
      <dt>Rating</dt>
      <dd>{ratingText(latest?.rating)} <span class="muted">({countText(latest?.ratingCount)})</span></dd>
    </div>
    <div><dt>Price</dt><dd>{latest?.price ?? '–'}</dd></div>
    <div class="wide"><dt>Last change</dt><dd>{lastChangeText(history, competitor, now)}</dd></div>
  </dl>

  <div class="row foot">
    <label class="check">
      <input type="checkbox" checked={comparing} onchange={ontoggle} />
      Compare
    </label>
    <span class="muted when">{competitor.lastCheckedAt ? `Looked at ${timeAgo(competitor.lastCheckedAt, now)}` : 'Not looked at yet'}</span>
    <span class="spacer"></span>
    {#if canWrite}
      {#if confirming}
        <span class="confirm">
          Stop following?
          <Button size="sm" variant="danger" loading={busy} onclick={onremove}>Remove</Button>
          <Button size="sm" variant="ghost" onclick={() => (confirming = false)}>Cancel</Button>
        </span>
      {:else}
        <Button size="sm" variant="ghost" iconOnly icon="trash" label="Stop following {competitor.name}" onclick={() => (confirming = true)} />
      {/if}
    {/if}
  </div>

  {#if changes.length > 0}
    <Disclosure summary="Change history ({changes.length})" stateKey="aso.competitor.{competitor.id}">
      <ul class="history">
        {#each changes as snap (snap.id)}
          <li>
            <time class="muted" datetime={new Date(snap.checkedAt).toISOString()}>{new Date(snap.checkedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time>
            <ul>
              {#each snap.changes ?? [] as c, i (i)}<li>{changeText(c)}</li>{/each}
            </ul>
          </li>
        {/each}
      </ul>
    </Disclosure>
  {/if}
</article>

<style>
  .competitor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: 0.9375rem;
    min-width: 0;
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--text-lg);
  }

  .sub {
    margin: 0;
    font-size: 0.9375rem;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2) var(--space-3);
    margin: 0;
  }

  .facts dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }

  .wide {
    grid-column: 1 / -1;
  }

  .foot {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .check {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .when {
    font-size: var(--text-sm);
  }

  .confirm {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-size: 0.9375rem;
  }

  .history,
  .history ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .history > li {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-top: 1px solid var(--line);
  }

  .history > li:first-child {
    border-top: 0;
  }
</style>
