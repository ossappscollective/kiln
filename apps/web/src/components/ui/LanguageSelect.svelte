<!--
  LanguageSelect: choose the language of the app. The choice is saved in this browser (`kiln.locale`) and applies at once.
  Props: layout = 'inline' (label beside the select, for a footer) | 'stacked' (small heading above, for a menu or a card), block (fill the width).
  The label is always visible; each option is written in its own language and carries its own `lang`.
-->
<script lang="ts">
  import { i18n, pickerLocales, setLocale } from '../../lib/i18n/i18n.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';

  let { layout = 'inline', block = false }: { layout?: 'inline' | 'stacked' | undefined; block?: boolean | undefined } = $props();

  const uid = $props.id();
</script>

<div class="language {layout}" class:block>
  <label for="{uid}-language" class:eyebrow={layout === 'stacked'}>{t('common:language.label')}</label>
  <select id="{uid}-language" value={i18n.locale} aria-busy={i18n.switching} onchange={(e) => void setLocale(e.currentTarget.value)}>
    {#each pickerLocales as l (l.code)}
      <option value={l.code} lang={l.htmlLang}>{l.name}</option>
    {/each}
  </select>
</div>

<style>
  .language {
    display: flex;
    gap: var(--space-2);
  }

  .inline {
    flex-direction: row;
    align-items: center;
  }

  .stacked {
    flex-direction: column;
    align-items: flex-start;
  }

  .inline label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .stacked label {
    margin: 0;
  }

  select {
    width: auto;
    min-width: 0;
  }

  .block,
  .block select {
    width: 100%;
  }

  .inline select {
    min-height: 32px;
    font-size: var(--text-sm);
  }
</style>
