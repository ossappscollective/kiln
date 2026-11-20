<!--
  FieldEditor: one listing field with its store limit.
  Props: spec (the field's rules from @mrm/core), id, value, original (the text in the repository,
  undefined when the field has no file), readonly, problems (what validateListing found for this
  field), onchange (called with the new text), label? (overrides the spec's label).
  The counter measures the way the store does (characters or bytes) and turns to an error when the
  limit is passed. The rule and its source sit under the field.
-->
<script lang="ts">
  import type { ListingFieldSpec, ListingProblem } from '@mrm/core';
  import { fieldUsage } from '../../lib/repositories.ts';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import ExternalLink from '../credentials/ExternalLink.svelte';

  let {
    spec,
    id,
    value,
    original,
    readonly = false,
    problems = [],
    label,
    onchange,
  }: {
    spec: ListingFieldSpec;
    id: string;
    value: string;
    original: string | undefined;
    readonly?: boolean | undefined;
    problems?: ListingProblem[] | undefined;
    label?: string | undefined;
    onchange: (value: string) => void;
  } = $props();

  const usage = $derived(fieldUsage(spec, value));
  const edited = $derived(value !== (original ?? ''));
  const rows = $derived(spec.kind === 'keywords' ? 3 : spec.id === 'description' || spec.id === 'full_description' ? 10 : 5);
  const multiline = $derived(spec.kind === 'multiline' || spec.kind === 'keywords');
  const errors = $derived(problems.filter((p) => p.severity === 'error'));
  const warnings = $derived(problems.filter((p) => p.severity === 'warning'));
  const describedBy = $derived(
    [`${id}-count`, spec.note || spec.source ? `${id}-note` : '', problems.length > 0 ? `${id}-problems` : '']
      .filter(Boolean)
      .join(' '),
  );
</script>

<div class="field">
  <div class="head">
    <label for={id}>{label ?? spec.label}</label>
    <span class="meta">
      {#if spec.required}<span class="muted small">Required</span>{/if}
      {#if edited}<Badge tone="info">Edited</Badge>{/if}
      <span id="{id}-count" class="count tabular" class:over={usage.over}>{usage.text}{#if usage.over}<span class="visually-hidden">, over the limit</span>{/if}</span>
    </span>
  </div>

  {#if multiline}
    <textarea
      {id}
      {rows}
      {value}
      {readonly}
      spellcheck={spec.kind === 'multiline'}
      aria-invalid={errors.length > 0 || usage.over ? 'true' : undefined}
      aria-describedby={describedBy}
      oninput={(e) => onchange(e.currentTarget.value)}
    ></textarea>
  {:else}
    <input
      {id}
      type="text"
      {value}
      {readonly}
      autocomplete="off"
      spellcheck={spec.kind === 'text'}
      aria-invalid={errors.length > 0 || usage.over ? 'true' : undefined}
      aria-describedby={describedBy}
      oninput={(e) => onchange(e.currentTarget.value)}
    />
  {/if}

  {#if spec.note || spec.source}
    <p class="hint" id="{id}-note">
      {#if spec.note}{spec.note}{' '}{/if}
      <ExternalLink href={spec.source} label="Source" />
    </p>
  {/if}

  {#if problems.length > 0}
    <ul class="problems" id="{id}-problems">
      {#each errors as problem, i (i)}
        <li class="field-error">
          <Icon name="alert" size={14} class="field-error-icon" />
          <span>{problem.message}</span>
        </li>
      {/each}
      {#each warnings as problem, i (i)}
        <li class="warning">
          <Icon name="alert-triangle" size={14} />
          <span><span class="visually-hidden">Warning: </span>{problem.message}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .head {
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--space-1);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
  }

  .small {
    font-size: var(--text-xs);
  }

  .count {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .count.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .problems {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .warning {
    display: flex;
    gap: var(--space-1);
    align-items: flex-start;
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    line-height: 1.33;
    color: var(--warn-ink);
  }
</style>
