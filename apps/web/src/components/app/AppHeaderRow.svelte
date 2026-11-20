<!--
  AppHeaderRow: platform, version and locale of a versioned app page as one compact row, in that order
  (Listing, Releases, Assets, ASO fit). The platform control keeps iOS | macOS | Android | Both; the
  version carries its state (dot and word); the locale is a plain select with "All locales". The choices
  live in the address (?platform=&version=&locale=), so every tab of the app reads the same ones.
  Props: scopeOptions, scope, onscope (the platform control, see ScopeControl), showScope = true (false for an app on one platform), versions, version, onversion,
  showVersion, locales, locale, onlocale, showLocale. The locale list is what a page has read so far; with
  none it is one disabled "All locales" control.
-->
<script lang="ts">
  import type { PlatformScope, ScopeOption } from '../../lib/app-scope.ts';
  import type { VersionOption } from '../../lib/app-header.ts';
  import ScopeControl from './ScopeControl.svelte';
  import VersionPicker from './VersionPicker.svelte';

  let {
    scopeOptions,
    scope,
    onscope,
    showScope = true,
    versions,
    version,
    onversion,
    showVersion = true,
    locales,
    locale,
    onlocale,
    showLocale = true,
  }: {
    scopeOptions: ScopeOption[];
    scope: PlatformScope;
    onscope: (scope: PlatformScope) => void;
    /** False for an app on one platform: there is nothing to choose. */
    showScope?: boolean | undefined;
    versions: VersionOption[];
    version: string | null;
    onversion: (version: string) => void;
    showVersion?: boolean | undefined;
    locales: string[];
    locale: string | null;
    onlocale: (locale: string | null) => void;
    showLocale?: boolean | undefined;
  } = $props();

  const uid = $props.id();
</script>

<div class="row picks" role="group" aria-label="What you are looking at">
  {#if showScope}<ScopeControl options={scopeOptions} {scope} onchange={onscope} />{/if}
  {#if showVersion}<VersionPicker options={versions} value={version} onchange={onversion} />{/if}
  {#if showLocale}
    <label class="pick" for="{uid}-locale">
      <span class="lbl">Locale</span>
      <select id="{uid}-locale" disabled={locales.length === 0} value={locale ?? ''} onchange={(e) => onlocale(e.currentTarget.value === '' ? null : e.currentTarget.value)}>
        <option value="">All locales</option>
        {#each locales as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </label>
  {/if}
</div>

<style>
  .picks {
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .pick {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-1) 0 var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .pick:hover:not(:has(select:disabled)) {
    border-color: var(--line-hover);
  }

  .pick:has(select:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .lbl {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .pick select {
    min-height: calc(var(--control-md) - 4px);
    padding-left: var(--space-1);
    background-color: transparent;
    border: 0;
    box-shadow: none;
  }

  .pick select:focus-visible {
    outline: none;
  }
</style>
