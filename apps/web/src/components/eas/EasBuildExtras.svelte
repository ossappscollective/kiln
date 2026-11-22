<!--
  EasBuildExtras: the lines of an EAS build row that the other sources have no use for: the commit it was built from and, when the build
  failed, the reason Expo gave. The text comes from Expo (a commit message, an error) and is shown as plain text, never as HTML.
  Props: build (an EAS build of the stored status).
-->
<script lang="ts">
  import type { EasBuildView } from '../../lib/eas/eas-status.ts';
  import { t } from '../../lib/i18n/t.ts';

  let { build }: { build: EasBuildView } = $props();
</script>

{#if build.gitCommitMessage}
  <div class="muted text-sm commit" title={build.gitCommitHash ?? ''}>{build.gitCommitMessage}</div>
{/if}
{#if build.error}
  <div class="error text-sm" role="note" data-testid="eas-build-error">
    <strong>{t('eas:build.failed')}</strong>
    {#if build.error.message}{build.error.message}{/if}
    {#if build.error.code}<span class="code">{build.error.code}</span>{/if}
  </div>
{/if}

<style>
  .commit {
    overflow-wrap: anywhere;
  }

  .error {
    padding: var(--space-2) var(--space-3);
    color: var(--bad-ink, var(--warn-ink));
    background: var(--bad-bg, var(--warn-bg));
    border-radius: var(--radius-md);
    overflow-wrap: anywhere;
  }

  .code {
    margin-left: var(--space-2);
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs);
    opacity: 0.8;
  }
</style>
