<!--
  EasSubmissions: the EAS submissions of the linked Expo project (builds sent to App Store Connect or Google Play) of this app record,
  newest first: the build that was submitted, the store it went to, the state, when, and the reason when it failed. READ ONLY: nothing is
  submitted, cancelled or retried from here; the link opens the submission on Expo.
  Props: status (the stored EAS status of the app), now.
-->
<script lang="ts">
  import { easSubmissionBuild, easSubmissionState, easSubmissionTarget, type EasStatusView } from '../../lib/eas/eas-status.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Section from '../ui/Section.svelte';

  let { status, now }: { status: EasStatusView; now: number } = $props();
</script>

{#if status.project && status.submissions.length > 0}
  <Section title={t('eas:submissions.title')} key="eas-submissions" count={status.submissions.length} flush>
    <ul class="rows" aria-label={t('eas:submissions.listLabel')}>
      {#each status.submissions as s (s.id)}
        {@const state = easSubmissionState(s)}
        <li class="row">
          <div class="head">
            <span class="line">
              <PlatformBadge platform={s.platform} />
              <strong>{easSubmissionBuild(s)}</strong>
              <Badge tone="neutral">EAS</Badge>
            </span>
            <Badge tone={state.tone} dot>{state.label}</Badge>
          </div>
          <div class="meta muted text-sm">
            <span>{easSubmissionTarget(s)}</span>
            {#if s.createdAt !== null}<time datetime={new Date(s.createdAt).toISOString()} title={formatDateTime(s.createdAt)}>{formatRelativeTime(s.createdAt, { now })}</time>{/if}
            {#if s.releaseStatus}<span>{t('eas:submissions.release', { status: s.releaseStatus.toLowerCase() })}</span>{/if}
            {#if s.expoUrl}
              <a href={s.expoUrl} target="_blank" rel="noopener noreferrer">{t('eas:submissions.openOnExpo')}<Icon name="external-link" size={12} /><span class="visually-hidden"> {t('eas:link.newTab')}</span></a>
            {/if}
          </div>
          {#if s.error}
            <div class="error text-sm" role="note" data-testid="eas-submission-error">
              <strong>{t('eas:submissions.failed')}</strong>
              {#if s.error.message}{s.error.message}{/if}
              {#if s.error.code}<span class="code">{s.error.code}</span>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if status.sync.submissionsTruncated}<p class="more muted text-sm">{t('eas:submissions.truncated')}</p>{/if}
  </Section>
{/if}

<style>
  .rows {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
  }

  .row + .row {
    border-top: 1px solid var(--line);
  }

  .head {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    min-width: 0;
  }

  .line {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-2);
    align-items: center;
    overflow-wrap: anywhere;
  }

  .meta > :global(* + *)::before {
    margin-right: var(--space-2);
    color: var(--faint);
    content: '·';
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

  .more {
    padding: var(--space-2) var(--space-4);
    margin: 0;
  }
</style>
