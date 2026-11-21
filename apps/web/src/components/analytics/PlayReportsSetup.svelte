<!--
  PlayReportsSetup: what an Android app is missing when Insights shows crash and ANR numbers but no downloads. Installs and ratings are
  not in Google's Reporting API; they are monthly CSV files in the private Cloud Storage bucket of the Play account, which needs the
  bucket and a read grant. Until the app has a bucket (its own, its Play account's, or the workspace default) this takes the place of the
  silent gap: a status line per source ("Vitals: connected · Installs: not set up"), three numbered steps, the field for the bucket of
  THIS app, and "Import a Play Console CSV instead" (the same installs numbers from a file, no Cloud Storage access needed).
  Drawn with the Section primitive. The grants named in step 2 are UNVERIFIED (docs/research/analytics-apis.md): the test button says
  `bucket_forbidden` if they are not enough.
  Props: api, workspaceId, role, app (id, platform), status, onchanged (read the status again).
  Readable pass (docs/design/readability.md): the status line, ONE sentence on why, the field of the bucket (its Save is the one primary), then
  the three steps at 15px (open, because this card only shows while the bucket is missing) and the quiet alternatives.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, playSourceLine } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Button from '../ui/Button.svelte';
  import T from '../ui/T.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import '../readable-card.css';
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
  title={t('analytics:playSetup.title')}
  key="play-bucket.{app.id}"
  summary={playSourceLine(status)}
>
  <div class="stack readable-card">
    <p class="line" data-testid="play-source-line">{playSourceLine(status)}</p>
    <p class="muted">{t('analytics:playSetup.why')}</p>
    <PlayBucketField {api} {workspaceId} {role} {app} heading={false} {onchanged} />
    <Disclosure summary={t('analytics:playSetup.how')} open>
      <ol class="steps">
        <li><T key="analytics:playSetup.step1" /></li>
        <li><T key="analytics:playSetup.step2" /></li>
        <li>{t('analytics:playSetup.step3')}</li>
        <li><T key="analytics:playSetup.step4" /></li>
      </ol>
    </Disclosure>
    <div class="row">
      {#if canManage}
        <Button size="sm" icon="upload" onclick={() => (importOpen = true)}>{t('analytics:playSetup.importCsv')}</Button>
      {/if}
      <a href="#/settings?view=analytics">{t('analytics:playSetup.workspaceLink')}</a>
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

  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding-left: var(--space-5);
    font-size: 0.9375rem;
  }
</style>
