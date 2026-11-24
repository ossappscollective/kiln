<!--
  AppearanceSection: how the interface is tinted for this app (docs/adr/0068-app-tint.md). Auto uses the main colours of the app icon,
  Off keeps the default accent for this app, Custom takes a colour a person picks. Any colour is safe: the same derivation (lib/tint/tokens.ts)
  searches the lightness until every pair meets WCAG on the real theme surfaces, and gives up (no tint) when it cannot. A live preview wears
  the derived tokens, and the table lists them with the contrast they meet in the light and the dark theme. A person who turned the tint off
  for themselves (account menu) sees no tint whatever is chosen here, and the section says so.
  The choice is stored for the workspace per record of the app (iOS and Android records are saved together) and applies at once, no reload.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { type Api, ApiError } from '../../../lib/api.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import { isColor, type AppAppearance } from '../../../lib/tint/prefs.ts';
  import { tint } from '../../../lib/tint/store.svelte.ts';
  import { tokenRows } from '../../../lib/tint/summary.ts';
  import { deriveTint } from '../../../lib/tint/tokens.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const mayEdit = $derived(can(role, 'apps.write'));
  const first = $derived(members[0]?.id ?? '');
  const saved = $derived(tint.overrideOf(first));

  let picked = $state('');
  let saving = $state(false);
  let problem = $state('');
  const color = $derived(isColor(picked) ? picked : saved.tint === 'custom' && saved.color ? saved.color : '#3b82f6');
  const mode = $derived(saved.tint);

  const palette = $derived(tint.paletteOf(first));
  /** What the preview shows: the pick, or the icon's primary, derived with the same rule as the page. */
  const previewColor = $derived(mode === 'custom' ? color : palette && !palette.neutral ? (palette.colors[0] ?? null) : null);
  const tinted = $derived(previewColor ? deriveTint(previewColor) : null);
  const previewStyle = $derived(tinted ? tint.styleOfColor(previewColor as string) : '');
  const rows = $derived(tinted ? tokenRows(tinted) : []);

  async function save(value: AppAppearance) {
    if (!mayEdit || saving) return;
    saving = true;
    problem = '';
    try {
      await Promise.all(members.map((m) => api.updateAppAppearance(workspaceId, m.id, value)));
      for (const m of members) tint.setOverride(m.id, value);
      toast.success(t('app:appearance.saved'));
    } catch (e) {
      problem = e instanceof ApiError && e.status === 403 ? t('app:appearance.forbidden') : t('app:appearance.saveFailed');
    } finally {
      saving = false;
    }
  }

  const choose = (next: AppAppearance['tint']) => save(next === 'custom' ? { tint: 'custom', color } : { tint: next });
  const ratioText = (n: number) => `${(Math.floor(n * 10) / 10).toFixed(1)}:1`;
</script>

<SettingsCard title={t('app:settings.part.appearance')} icon="sparkles" description={t('app:appearance.description')}>
  <div class="stack">
    {#if !tint.enabled}<Alert tone="info">{t('app:appearance.personalOff')}</Alert>{/if}
    <fieldset class="group">
      <legend>{t('app:appearance.legend')}</legend>
      {#each [{ id: 'auto', label: t('app:appearance.auto') }, { id: 'off', label: t('app:appearance.off') }, { id: 'custom', label: t('app:appearance.custom') }] as choice (choice.id)}
        <label class="option">
          <input type="radio" name="{uid}-tint" value={choice.id} checked={mode === choice.id} disabled={!mayEdit || saving} onchange={() => choose(choice.id as AppAppearance['tint'])} />
          <span>{choice.label}</span>
        </label>
      {/each}
      {#if mode === 'custom'}
        <div class="picker">
          <label for="{uid}-color">{t('app:appearance.colorLabel')}</label>
          <input id="{uid}-color" type="color" value={color} disabled={!mayEdit || saving} oninput={(e) => (picked = e.currentTarget.value)} onchange={(e) => save({ tint: 'custom', color: e.currentTarget.value })} />
          <code>{color}</code>
        </div>
      {/if}
    </fieldset>

    {#if mode === 'off'}
      <p class="muted note">{t('app:appearance.offNote')}</p>
    {:else if !tinted}
      <p class="muted note" data-testid="no-tint">{mode === 'custom' ? t('app:appearance.noTintCustom') : t('app:appearance.noTintIcon')}</p>
    {:else}
      <div class="preview" data-app-tint style={previewStyle} data-testid="tint-preview">
        <p class="preview-title">{t('app:appearance.preview')}</p>
        <div class="preview-row">
          <Button variant="primary" onclick={() => {}}>{t('app:appearance.sampleButton')}</Button>
          <span class="chip">{t('app:appearance.sampleChip')}</span>
          <a href="#/" onclick={(e) => e.preventDefault()}>{t('app:appearance.sampleLink')}</a>
        </div>
      </div>
      <table class="tokens" data-testid="tint-tokens">
        <caption class="visually-hidden">{t('app:appearance.tableCaption')}</caption>
        <thead>
          <tr><th scope="col">{t('app:appearance.col.token')}</th><th scope="col">{t('common:theme.light')}</th><th scope="col">{t('common:theme.dark')}</th></tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <th scope="row">{t(row.labelKey)}</th>
              {#each ['light', 'dark'] as const as scheme (scheme)}
                <td><span class="swatch" style:background={row.hex[scheme]} aria-hidden="true"></span> <code>{row.hex[scheme].slice(0, 7)}</code> {ratioText(row.ratio[scheme])}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="hint">{t('app:appearance.rule')}</p>
    {/if}
    {#if !mayEdit}<p class="muted note">{t('app:appearance.readOnly')}</p>{/if}
    {#if problem}<Alert tone="error" title={t('app:appearance.notSaved')}>{problem}</Alert>{/if}
  </div>
</SettingsCard>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .option,
  .picker {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .note {
    margin: 0;
  }

  .muted {
    color: var(--muted);
  }

  .preview {
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .preview-title {
    margin: 0 0 var(--space-2);
    color: var(--muted);
  }

  .preview-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .chip {
    padding: var(--space-1) var(--space-2);
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-radius: var(--radius-full);
  }

  .tokens {
    border-collapse: collapse;
  }

  .tokens th,
  .tokens td {
    padding: var(--space-1) var(--space-3);
    text-align: start;
  }

  .swatch {
    display: inline-block;
    width: var(--space-4);
    height: var(--space-4);
    vertical-align: middle;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
  }
</style>
