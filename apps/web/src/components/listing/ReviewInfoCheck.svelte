<!--
  ReviewInfoCheck: the App Review Information of the App Store version, as an early Checks item on the Listing page and the Release page.
  The submit refuses a version whose review contact (first and last name, phone, email) or demo account is blank; this says so before the
  publish dialog does, from the same reading of the store (`GET /apps/:id/publish/readiness`, the ONE core rule `evaluateReviewInformation`).
  Drawn only for an App Store app, only for a role that may submit, only when something is missing. One button, "Copy review information from <version>" (ReviewInfoCopy), copies the previous version's information into the blanks.
  Props: api, workspaceId, role, app.
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { listingStore } from '../../lib/app-state/listing-store.svelte.ts';
  import { reviewLinesOf } from '../../lib/listing/review-check.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import { provideReviewRepair } from '../../lib/review-repair-context.ts';
  import ReviewInfoCopy from '../publish/ReviewInfoCopy.svelte';
  import Alert from '../ui/Alert.svelte';
  import Icon from '../ui/Icon.svelte';

  let { api, workspaceId, role, app }: { api: Api; workspaceId: string; role: Role; app: AppSummary } = $props();

  $effect(() => {
    void listingStore.loadReview(api, workspaceId, role, app);
  });

  // "Copy review information from 1.19.0": the one-click repair, here where the check is (the Listing page and every step of Prepare release).
  // Afterwards the check reads the store again at once.
  provideReviewRepair(() => ({
    api,
    workspaceId,
    role,
    app: { id: app.id, name: app.name, platform: app.platform },
    onrepaired: () => void listingStore.reloadReview(api, workspaceId, app.id),
  }));

  const lines = $derived(reviewLinesOf(app.platform, listingStore.review(workspaceId, app.id)));
</script>

{#if lines.length > 0}
  <div data-testid="review-info-check">
    <Alert tone="warn" title={t('listing:reviewCheck.title', { count: lines.length })}>
      <ul class="lines">
        {#each lines as line (line.id)}
          <li data-code={line.code}>
            <span>{line.message}</span>
            {#if line.href !== null && line.where !== null}
              <a class="small" href={line.href} target={line.external ? '_blank' : undefined} rel={line.external ? 'noopener noreferrer' : undefined}>{line.where}{#if line.external} <Icon name="external-link" size={12} />{/if}</a>
            {/if}
          </li>
        {/each}
      </ul>
      <ReviewInfoCopy from={lines[0]?.reviewFrom ?? null} />
    </Alert>
  </div>
{/if}

<style>
  .lines { margin: 0; padding-left: 1.2em; display: grid; gap: var(--space-1, 4px); }
  .small { font-size: var(--font-small, 0.85em); }
</style>
