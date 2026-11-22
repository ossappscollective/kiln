<!--
  DiffText: one side of an inline word diff. `from` is the older or other text, `to` the one it is
  compared with. `side="from"` shows `from` with the words that `to` does not have; `side="to"`
  shows `to` with the words that `from` does not have.
  Props: from, to, side = 'from' | 'to'.
  The marks are not color alone: removed words are struck through and added words are underlined,
  and screen readers hear "only in the store" or "only in the repository" around them, using the
  `fromName` and `toName` labels.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { diffWords } from '../../lib/listing/drift.ts';

  let {
    from,
    to,
    side,
    fromName,
    toName,
  }: { from: string; to: string; side: 'from' | 'to'; fromName?: string | undefined; toName?: string | undefined } = $props();

  const fromLabel = $derived(fromName ?? t('listing:diff.name.otherSide'));
  const toLabel = $derived(toName ?? t('listing:diff.name.thisSide'));
  const parts = $derived(diffWords(from, to));
  const shown = $derived(parts.filter((p) => p.kind === 'same' || p.kind === (side === 'from' ? 'del' : 'ins')));
</script>

<span class="text"
  >{#each shown as part, i (i)}{#if part.kind === 'same'}{part.text}{:else if part.kind === 'del'}<del><span class="visually-hidden">{t('listing:diff.onlyInOpen', { name: fromLabel })}</span>{part.text}<span class="visually-hidden">{t('listing:diff.onlyInClose')}</span></del>{:else}<ins><span class="visually-hidden">{t('listing:diff.onlyInOpen', { name: toLabel })}</span>{part.text}<span class="visually-hidden">{t('listing:diff.onlyInClose')}</span></ins>{/if}{/each}</span
>

<style>
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  del,
  ins {
    padding: 0 1px;
    border-radius: var(--radius-sm);
  }

  del {
    color: var(--bad-ink);
    text-decoration: line-through;
    background: var(--bad-bg);
  }

  ins {
    color: var(--ok-ink);
    text-decoration: underline;
    text-decoration-style: solid;
    background: var(--ok-bg);
  }
</style>
