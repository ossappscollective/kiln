<script lang="ts" module>
  let counter = 0;
</script>

<script lang="ts">
  import { type CredentialKind, credentialGuides, credentialKindInfo } from '@mrm/core';
  import { tick } from 'svelte';
  import { formatCheckedOn, guideSections } from '../../lib/credentials.ts';
  import { storeForCredentialKind } from '../../lib/stores.ts';
  import Icon from '../ui/Icon.svelte';
  import ExternalLink from './ExternalLink.svelte';

  let {
    kind,
    collapsible = false,
  }: {
    kind: CredentialKind;
    /** Wrap the whole guide in a disclosure that starts closed. */
    collapsible?: boolean;
  } = $props();

  const uid = `guide-${++counter}`;
  const guide = $derived(credentialGuides[kind]);
  const sections = $derived(guideSections(guide));
  const checked = $derived(formatCheckedOn(guide.checkedOn));

  let outerOpen = $state(false);
  let troubleOpen = $state(false);
  let troubleSummary = $state<HTMLElement>();

  /** Opens whatever is closed and moves focus to the troubleshooting list. */
  export async function showTroubleshooting() {
    if (!sections.troubleshooting) return;
    outerOpen = true;
    troubleOpen = true;
    await tick();
    troubleSummary?.focus();
    troubleSummary?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
</script>

{#snippet body()}
  <p class="summary">{guide.summary}</p>

  {#if sections.prerequisites}
    <div class="needs">
      <h4>You will need</h4>
      <ul>
        {#each guide.prerequisites as item}<li>{item}</li>{/each}
      </ul>
    </div>
  {/if}

  {#if sections.steps}
    <h4 id="{uid}-steps">Steps</h4>
    <ol class="steps" aria-labelledby="{uid}-steps">
      {#each guide.steps as step}
        <li>
          <strong>{step.title}</strong>
          <p>{step.body}</p>
          {#if step.link}<p class="link"><ExternalLink href={step.link.url} label={step.link.label} /></p>{/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if sections.permissions}
    <h4>Access to grant</h4>
    <p class="hint lead">Give it no more than this.</p>
    <ul class="plain">
      {#each guide.permissions as item}<li>{item}</li>{/each}
    </ul>
  {/if}

  {#if sections.troubleshooting}
    <details class="trouble" bind:open={troubleOpen}>
      <summary bind:this={troubleSummary}>If something goes wrong</summary>
      <ul>
        {#each guide.troubleshooting as item}
          <li>
            <strong>{item.problem}</strong>
            <p>{item.fix}</p>
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if sections.links}
    <h4>Official documentation</h4>
    <ul class="plain">
      {#each guide.links as link}
        <li><ExternalLink href={link.url} label={link.label} /></li>
      {/each}
    </ul>
  {/if}

  {#if checked}<p class="hint checked">Last checked {checked}</p>{/if}
{/snippet}

{#if collapsible}
  <details class="panel outer" bind:open={outerOpen}>
    <summary>How to get this credential</summary>
    <div class="inner">{@render body()}</div>
  </details>
{:else}
  <section class="panel" aria-labelledby="{uid}-title">
    <h3 id="{uid}-title">How to get this</h3>
    <p class="kind muted"><Icon name={storeForCredentialKind(kind).icon} /> {credentialKindInfo[kind].label}</p>
    {@render body()}
  </section>
{/if}

<style>
  .panel {
    padding: 16px 18px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
  }

  h3 {
    font-size: 15px;
  }

  h4 {
    margin: 16px 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .kind {
    margin: 2px 0 10px;
    font-size: 12px;
  }

  .summary {
    margin: 0;
  }

  .outer > summary {
    font-weight: 600;
    cursor: pointer;
  }

  .outer .inner {
    margin-top: 10px;
  }

  .needs {
    margin-top: 14px;
    padding: 10px 12px;
    background: var(--warn-bg);
    color: var(--warn-ink);
    border-radius: 6px;
  }

  .needs h4 {
    margin: 0 0 4px;
    color: inherit;
  }

  .needs ul {
    margin: 0;
    padding-left: 18px;
  }

  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
  }

  .steps li {
    position: relative;
    padding: 0 0 12px 34px;
    counter-increment: step;
  }

  .steps li::before {
    content: counter(step);
    position: absolute;
    top: 0;
    left: 0;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 50%;
  }

  .steps p {
    margin: 2px 0 0;
  }

  .steps .link {
    font-size: 13px;
  }

  .plain {
    margin: 0;
    padding-left: 18px;
  }

  .lead {
    margin: 0 0 4px;
  }

  .trouble {
    margin-top: 16px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .trouble summary {
    font-weight: 600;
    cursor: pointer;
  }

  .trouble summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .trouble ul {
    margin: 8px 0 0;
    padding-left: 18px;
  }

  .trouble li {
    margin-bottom: 8px;
  }

  .trouble p {
    margin: 2px 0 0;
  }

  .checked {
    margin-top: 14px;
  }
</style>
