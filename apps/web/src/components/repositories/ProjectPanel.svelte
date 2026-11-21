<!--
  ProjectPanel: what a scan found in a repository: the project type, where things live, the
  evidence behind it and any warnings. Props: api, workspaceId, repository, detection (the last
  scan, or null), canScan, onscanned (called with the new result).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    detectionPaths,
    platformsSummary,
    projectKindSummary,
    repositoryName,
    strengthLabel,
  } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ProjectDetection, RepositoryDetail, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import KindBadge from './KindBadge.svelte';
import { supports } from '@kiln/core';

  let {
    api,
    workspaceId,
    repository,
    detection,
    canScan,
    onscanned,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    detection: ProjectDetection | null;
    canScan: boolean;
    onscanned: (detail: RepositoryDetail) => void;
  } = $props();

  let scanning = $state(false);
  let error = $state('');

  async function scan() {
    scanning = true;
    error = '';
    try {
      const detail = await api.scanRepository(workspaceId, repository.id);
      onscanned(detail);
      toast.success(t('repositories:project.scanned', { name: repositoryName(repository) }));
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('repositories:project.scanFailed');
    } finally {
      scanning = false;
    }
  }

  const paths = $derived(detection ? detectionPaths(detection) : []);
  const localeRows = $derived(
    detection
      ? [
          { label: t('repositories:project.localesApp'), values: detection.locales.ios },
          { label: t('repositories:project.localesPlay'), values: detection.locales.android },
        ].filter((row) => row.values.length > 0)
      : [],
  );
  const expoRows = $derived.by(() => {
    const expo = detection?.expo;
    if (!expo) return [];
    const rows: Array<[string, string]> = [];
    if (expo.name) rows.push([t('repositories:project.expoName'), expo.name]);
    if (expo.slug) rows.push([t('repositories:project.expoSlug'), expo.slug]);
    if (expo.version) rows.push([t('repositories:project.expoVersion'), expo.version]);
    if (expo.iosBundleIdentifier) rows.push([t('repositories:project.expoIosBundle'), expo.iosBundleIdentifier]);
    if (expo.androidPackage) rows.push([t('repositories:project.expoAndroidPackage'), expo.androidPackage]);
    if (expo.buildProfiles.length > 0) rows.push([t('repositories:project.expoBuildProfiles'), expo.buildProfiles.join(', ')]);
    if (expo.submitProfiles.length > 0) rows.push([t('repositories:project.expoSubmitProfiles'), expo.submitProfiles.join(', ')]);
    for (const config of expo.storeConfigs) {
      rows.push([
        config.profile
          ? t('repositories:project.storeConfigProfile', { profile: config.profile })
          : t('repositories:project.storeConfig'),
        config.dynamic ? t('repositories:project.storeConfigDynamic', { path: config.path }) : config.path,
      ]);
    }
    return rows;
  });
</script>

<div class="stack loose">
  {#if error}
    <div class="stack">
      <Alert tone="error">{error}</Alert>
      {#if canScan}<div><Button icon="refresh" onclick={scan}>{t('common:action.tryAgain')}</Button></div>{/if}
    </div>
  {/if}

  {#if scanning}
    <div class="card" role="status" aria-label={t('repositories:project.scanningAria')}>
      <div class="stack">
        <Skeleton width="40%" height="20px" />
        <Skeleton width="80%" height="14px" />
        <Skeleton width="60%" height="14px" />
        <p class="muted">{t('repositories:project.scanningHint')}</p>
      </div>
    </div>
  {:else if detection === null}
    <div class="card">
      <EmptyState
        icon="search"
        title={t('repositories:project.emptyTitle')}
        description={canScan ? t('repositories:project.emptyWrite') : t('repositories:project.emptyRead')}
      >
        {#snippet actions()}
          {#if canScan}<Button variant="primary" icon="search" onclick={scan}>{t('repositories:project.scan')}</Button>{/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <Card title={t('repositories:project.typeTitle')} collapseKey="project-type" description={projectKindSummary(detection.kind)}>
      {#snippet actions()}
        {#if canScan}<Button icon="refresh" onclick={scan}>{t('repositories:project.scanAgain')}</Button>{/if}
      {/snippet}
      <dl class="facts">
        <div>
          <dt>{t('repositories:project.detected')}</dt>
          <dd><KindBadge kind={detection.kind} /></dd>
        </div>
        <div>
          <dt>{t('repositories:project.platforms')}</dt>
          <dd>{platformsSummary(detection)}</dd>
        </div>
        {#if repository.detectedAt}
          <div>
            <dt>{t('repositories:list.lastScan')}</dt>
            <dd><time datetime={new Date(repository.detectedAt).toISOString()} title={formatDateTime(repository.detectedAt)}>{formatRelativeTime(repository.detectedAt)}</time></dd>
          </div>
        {/if}
      </dl>
    </Card>

    {#if detection.warnings.length > 0}
      <Alert tone="warn" title={detection.warnings.length === 1 ? t('repositories:project.warningOne') : t('repositories:project.warningMany')}>
        <ul class="plain">
          {#each detection.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if paths.length > 0 || localeRows.length > 0}
      <Card title={t('repositories:project.foundTitle')} collapseKey="found" defaultOpen={false} description={t('repositories:project.foundDescription')}>
        <dl class="facts stacked">
          {#each paths as row (row.label)}
            <div>
              <dt>{row.label}</dt>
              <dd>
                {#each row.values as value (value)}<code>{value}</code>{' '}{/each}
              </dd>
            </div>
          {/each}
          {#each localeRows as row (row.label)}
            <div>
              <dt>{row.label}</dt>
              <dd>{row.values.join(', ')}</dd>
            </div>
          {/each}
        </dl>
      </Card>
    {/if}

    {#if expoRows.length > 0}
      <Card title={t('repositories:project.expoTitle')} collapseKey="expo" description={t('repositories:project.expoDescription')}>
        <dl class="facts stacked">
          {#each expoRows as [label, value] (label)}
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          {/each}
        </dl>
        {#if detection.expo?.dynamicConfig}
          <p class="hint">{t('repositories:project.expoDynamic')}</p>
        {/if}
      </Card>
    {/if}

    <section class="stack" aria-labelledby="evidence-title">
      <h3 id="evidence-title">{t('repositories:project.evidenceTitle')}</h3>
      {#if detection.evidence.length === 0}
        <p class="muted">{t('repositories:project.evidenceNone')}</p>
      {:else}
        <div class="table-wrap">
          <table class="compact">
            <caption class="visually-hidden">{t('repositories:project.evidenceCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('repositories:project.evidenceFound')}</th>
                <th scope="col">{t('repositories:project.evidenceFile')}</th>
                <th scope="col">{t('repositories:project.evidencePlatform')}</th>
                <th scope="col">{t('repositories:project.evidenceCertainty')}</th>
              </tr>
            </thead>
            <tbody>
              {#each detection.evidence as item, i (i)}
                <tr>
                  <td>{item.fact}</td>
                  <td><code>{item.path}</code></td>
                  <td>{item.platform === 'ios' ? 'iOS' : item.platform === 'android' ? 'Android' : t('repositories:project.platformBoth')}</td>
                  <td>
                    <Badge tone={item.strength === 'definite' ? 'ok' : 'warn'}>{strengthLabel(item.strength)}</Badge>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="hint">{t('repositories:project.evidenceHint')}</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-8);
    margin: 0;
  }

  .facts > div {
    min-width: 0;
  }

  .facts.stacked {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: minmax(0, 1fr);
  }

  .facts.stacked > div {
    display: grid;
    gap: var(--space-1) var(--space-4);
    grid-template-columns: 200px minmax(0, 1fr);
    align-items: baseline;
  }

  dt {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  dd {
    margin: var(--space-1) 0 0;
    overflow-wrap: anywhere;
  }

  .stacked dd {
    margin: 0;
  }

  .plain {
    padding: 0;
    margin: var(--space-1) 0 0;
    list-style: none;
  }

  .plain li + li {
    margin-top: var(--space-1);
  }

  code {
    display: inline-block;
    margin: 0 var(--space-1) var(--space-1) 0;
  }

  @media (max-width: 720px) {
    .facts.stacked > div {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
