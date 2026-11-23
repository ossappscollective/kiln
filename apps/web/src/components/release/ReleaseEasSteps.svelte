<!--
  ReleaseEasSteps: under a store release of an Expo-linked app, the EAS build and its store submission as three steps: build finished, submitted,
  in store review. The build is the stored EAS build that matches the release by platform, version and build number (lib/eas/eas-release.ts);
  the submission is the one of that build; "in store review" comes from the store state the last sync read. When no single build matches there is
  nothing here (never a guess), and nothing for an app that is not linked, a role that may not read builds, or a platform EAS does not build.
  From the stored snapshot (`GET .../eas/status`): no call to Expo. The build links to the Builds page.
  Props: api, workspaceId, role, app, release.
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { matchRelease, type ReleaseEasStepId, type ReleaseEasStepState } from '../../lib/eas/eas-release.ts';
  import { easBuildTitle, type EasStatusView } from '../../lib/eas/eas-status.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';

  let { api, workspaceId, role, app, release }: { api: Api; workspaceId: string; role: Role; app: AppSummary; release: ReleaseSummary } = $props();

  const WORDS: Record<ReleaseEasStepId, Partial<Record<ReleaseEasStepState, string>>> = {
    built: {
      done: k('eas:releaseSteps.built.done'),
      current: k('eas:releaseSteps.built.current'),
      failed: k('eas:releaseSteps.built.failed'),
    },
    submitted: {
      done: k('eas:releaseSteps.submitted.done'),
      current: k('eas:releaseSteps.submitted.current'),
      failed: k('eas:releaseSteps.submitted.failed'),
      todo: k('eas:releaseSteps.submitted.todo'),
    },
    review: {
      done: k('eas:releaseSteps.review.done'),
      current: k('eas:releaseSteps.review.current'),
      failed: k('eas:releaseSteps.review.failed'),
      todo: k('eas:releaseSteps.review.todo'),
    },
  };

  let status = $state<EasStatusView | null>(null);
  const allowed = $derived(can(role, 'builds.read') && (app.platform === 'ios' || app.platform === 'android'));
  const match = $derived(matchRelease(release, status));
  const now = Date.now();

  $effect(() => {
    const id = app.id;
    if (!allowed) return;
    let current = true;
    untrack(() => {
      api
        .easStatus(workspaceId, id)
        .then((r) => {
          if (current) status = r.status;
        })
        .catch(() => {
          if (current) status = null;
        });
    });
    return () => {
      current = false;
    };
  });
</script>

{#if allowed && match}
  <div class="eas" data-testid="release-eas-steps">
    <p class="head text-sm muted">
      {t('eas:releaseSteps.title')} ·
      <a href={appAddress(app.id, 'builds', app.platform)} data-testid="release-eas-build-link">{easBuildTitle(match.build)}</a>
    </p>
    <ol class="steps">
      {#each match.steps as s (s.id)}
        {@const word = WORDS[s.id][s.state]}
        {#if word}
          <li class="s {s.state}" data-testid="release-eas-step-{s.id}" aria-current={s.state === 'current' ? 'step' : undefined}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{t(word)}</span>
            {#if s.at !== null && s.state !== 'todo'}
              <time class="muted text-sm" datetime={new Date(s.at).toISOString()} title={formatDateTime(s.at)}>{formatRelativeTime(s.at, { now })}</time>
            {/if}
          </li>
        {/if}
      {/each}
    </ol>
  </div>
{/if}

<style>
  .eas {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .head {
    margin: 0;
  }

  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .s {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border: 2px solid var(--line-strong);
    border-radius: 50%;
  }

  .s.done .dot {
    background: var(--ok-ink);
    border-color: var(--ok-ink);
  }

  .s.current .dot {
    border-color: var(--accent);
  }

  .s.failed .dot {
    background: var(--bad-ink);
    border-color: var(--bad-ink);
  }

  .s.todo {
    color: var(--muted);
  }
</style>
