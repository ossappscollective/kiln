<!--
  TintToggle: the person's own switch for the app tint (default on), in the account menu. Remembered in localStorage like the theme
  (lib/tint/prefs.ts). Off means no app colours anywhere (app pages and the reviews inbox), whatever each app is set to.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { tint } from '../../lib/tint/store.svelte.ts';

  const uid = $props.id();
</script>

<div class="tint-toggle">
  <label for="{uid}-tint" class="check">
    <input id="{uid}-tint" type="checkbox" checked={tint.enabled} onchange={(e) => tint.setEnabled(e.currentTarget.checked)} aria-describedby="{uid}-hint" />
    {t('common:tint.label')}
  </label>
  <p class="hint" id="{uid}-hint">{t('common:tint.hint')}</p>
</div>

<style>
  .tint-toggle {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm, 0.875rem);
  }
</style>
