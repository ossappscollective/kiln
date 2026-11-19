<!--
  PlayReportsSetup: what an Android app is missing when Insights shows crash and ANR numbers but no downloads. Installs and ratings are
  not in Google's Reporting API; they are monthly CSV files in the private Cloud Storage bucket of the Play account, which needs the
  bucket and a read grant. Until the app has a bucket (its own, its Play account's, or the workspace default) this takes the place of the
  silent gap: a status line per source ("Vitals: connected · Installs: not set up"), three numbered steps, the field for the bucket of
  THIS app, and "Import a Play Console CSV instead" (the same installs numbers from a file, no Cloud Storage access needed).
  Drawn with the Section primitive. The grants named in step 2 are UNVERIFIED (docs/research/analytics-apis.md): the test button says
  `bucket_forbidden` if they are not enough.
  Props: api, workspaceId, role, app (id, platform), status, onchanged (read the status again).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, playSourceLine } from '../../lib/analytics.ts';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import PlayBucketField from './PlayBucketField.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    status,
    onchanged,
  }: { api: Api; workspaceId: string; role: Role; app: { id: string; platform: string }; status: AnalyticsStatus; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  let importOpen = $state(false);
</script>

<Section
  title="Downloads need your Play reports bucket"
  key="play-bucket.{app.id}"
  summary={playSourceLine(status)}
>
  <div class="stack">
    <p class="line" data-testid="play-source-line">{playSourceLine(status)}</p>
    <p class="muted small">
      Google only publishes installs and ratings as monthly CSV files in a private Cloud Storage bucket of your Play account. Crash and ANR numbers do not
      need it, which is why those are here and downloads are not.
    </p>
    <ol class="steps">
      <li>
        In Play Console open <strong>Download reports</strong>, then <strong>Statistics</strong>, and press <strong>Copy Cloud Storage URI</strong> next to
        the section header. It starts with <code>gs://pubsite_prod_rev_</code>. It is the same bucket for every app of your Play account.
      </li>
      <li>
        Give the service account of this app's credential read access: <strong>Storage Object Viewer</strong> on that bucket, and in Play Console the
        permission to view app information and download bulk reports (read-only). Google does not say whether both are needed, so use the test below.
      </li>
      <li>Paste it here as the bucket of this app. Apps of another Play account get their own.</li>
    </ol>
    <PlayBucketField {api} {workspaceId} {role} {app} heading={false} {onchanged} />
    <div class="row">
      {#if canManage}
        <Button size="sm" icon="upload" onclick={() => (importOpen = true)}>Import a Play Console CSV instead</Button>
      {/if}
      <a class="small" href="#/settings?view=analytics">Use one bucket for every Android app: workspace settings</a>
    </div>
  </div>
</Section>

{#if canManage}
  <ImportReportDialog bind:open={importOpen} {api} {workspaceId} appId={app.id} android onimported={onchanged} />
{/if}

<style>
  .line {
    margin: 0;
    font-weight: var(--weight-medium, 500);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding-left: var(--space-5);
    font-size: var(--text-sm);
  }
</style>
