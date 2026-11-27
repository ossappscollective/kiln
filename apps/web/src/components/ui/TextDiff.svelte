<!--
  TextDiff: two texts compared (docs/adr/0067-diff-and-preview.md). Inline (one flow, removed text struck through, added text
  underlined) or side by side (before and after in two columns; below 640px they stack). Added and removed text is marked with
  <ins> and <del> AND by underline / strike-through, never by colour alone. Shows the character count before -> after with the
  store limit when it is known, the words added and removed, and a copy button for each side.
  Props: before, after (strings; null counts as empty), beforeLabel, afterLabel (what each side is: "Store", "Repository",
  "Staged"), limit? (number or null) with unit? ('characters' | 'bytes'), layout (bindable: 'inline' | 'side', default inline),
  mode? (diff mode of lib/diff/text-diff.ts, default auto).
  Pure view: no request, nothing is changed.
-->
<script lang="ts">
  import { measureField } from '@kiln/core';
  import { k, t } from '../../lib/i18n/t.ts';
  import { diffText, type DiffMode, sidesOf, statsLine } from '../../lib/diff/text-diff.ts';
  import Button from './Button.svelte';
  import CopyButton from './CopyButton.svelte';

  let {
    before,
    after,
    beforeLabel,
    afterLabel,
    limit = null,
    unit = 'characters',
    layout = $bindable('inline'),
    mode = 'auto',
  }: {
    before: string | null;
    after: string | null;
    beforeLabel: string;
    afterLabel: string;
    limit?: number | null | undefined;
    unit?: 'characters' | 'bytes' | undefined;
    layout?: 'inline' | 'side' | undefined;
    mode?: DiffMode | 'auto' | undefined;
  } = $props();

  const b = $derived(before ?? '');
  const a = $derived(after ?? '');
  const diff = $derived(diffText(b, a, { mode }));
  const sides = $derived(sidesOf(diff.segments));
  const size = (s: string) => measureField({ unit: unit ?? 'characters' }, s);
  const COUNTER = {
    chars: k('common:diff.chars'),
    bytes: k('common:diff.bytes'),
    charsLimit: k('common:diff.charsLimit'),
    bytesLimit: k('common:diff.bytesLimit'),
  };
  const counter = $derived(
    limit === null || limit === undefined
      ? t(COUNTER[unit === 'bytes' ? 'bytes' : 'chars'], { before: size(b), after: size(a) })
      : t(COUNTER[unit === 'bytes' ? 'bytesLimit' : 'charsLimit'], { before: size(b), after: size(a), limit }),
  );
  const over = $derived(limit !== null && limit !== undefined && size(a) > limit);
  const words = $derived(statsLine(diff.stats));
</script>

<div class="text-diff" data-testid="text-diff">
  <div class="bar">
    <span class="counter" class:over>{counter}</span>
    {#if words}<span class="muted words">{t('common:diff.words', { counts: words })}</span>{/if}
    <span class="spacer"></span>
    <div class="toggle" role="group" aria-label={t('common:diff.layout')}>
      <Button size="sm" variant={layout === 'inline' ? 'primary' : 'secondary'} aria-pressed={layout === 'inline'} onclick={() => (layout = 'inline')}>{t('common:diff.inline')}</Button>
      <Button size="sm" variant={layout === 'side' ? 'primary' : 'secondary'} aria-pressed={layout === 'side'} onclick={() => (layout = 'side')}>{t('common:diff.sideBySide')}</Button>
    </div>
  </div>

  {#if over}<p class="over-note">{t('common:diff.overLimit')}</p>{/if}
  {#if diff.identical}<p class="muted">{t('common:diff.identical')}</p>{/if}
  {#if diff.capped}<p class="muted">{t('common:diff.capped')}</p>{/if}

  {#if layout === 'inline'}
    <pre class="text" dir="auto" aria-label={t('common:diff.changes')}>{#if diff.segments.length === 0}<span class="empty">{t('common:diff.empty')}</span>{/if}{#each diff.segments as s}{#if s.kind === 'add'}<ins>{s.text}</ins>{:else if s.kind === 'del'}<del>{s.text}</del>{:else}<span>{s.text}</span>{/if}{/each}</pre>
  {:else}
    <div class="cols">
      <section aria-label={beforeLabel}>
        <h4>{beforeLabel}</h4>
        <pre class="text" dir="auto">{#if b === ''}<span class="empty">{t('common:diff.empty')}</span>{/if}{#each sides.before as s}{#if s.kind === 'del'}<del>{s.text}</del>{:else}<span>{s.text}</span>{/if}{/each}</pre>
      </section>
      <section aria-label={afterLabel}>
        <h4>{afterLabel}</h4>
        <pre class="text" dir="auto">{#if a === ''}<span class="empty">{t('common:diff.empty')}</span>{/if}{#each sides.after as s}{#if s.kind === 'add'}<ins>{s.text}</ins>{:else}<span>{s.text}</span>{/if}{/each}</pre>
      </section>
    </div>
  {/if}

  <div class="copies">
    <CopyButton value={b} iconOnly={false} label={t('common:diff.copySide', { side: beforeLabel })} />
    <CopyButton value={a} iconOnly={false} label={t('common:diff.copySide', { side: afterLabel })} />
  </div>
</div>

<style>
  .text-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }
  .spacer {
    flex: 1;
  }
  .toggle {
    display: flex;
    gap: var(--space-1);
  }
  .counter.over,
  .over-note {
    color: var(--bad-ink);
  }
  p {
    margin: 0;
    font-size: var(--text-sm);
  }
  h4 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    color: var(--muted);
    text-transform: none;
  }
  .text {
    margin: 0;
    padding: var(--space-3);
    max-height: 50vh;
    overflow: auto;
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .empty {
    color: var(--faint);
    font-style: italic;
  }
  ins {
    color: var(--ok-ink);
    background: var(--ok-bg);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
  del {
    color: var(--bad-ink);
    background: var(--bad-bg);
    text-decoration: line-through;
    text-decoration-thickness: 2px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  .cols section {
    min-width: 0;
  }
  .copies {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  @media (max-width: 640px) {
    .cols {
      grid-template-columns: 1fr;
    }
  }
</style>
