<!--
  ProjectPanel: what a scan found in a repository: the project type, where things live, the
  evidence behind it and any warnings. Props: api, workspaceId, repository, detection (the last
  scan, or null), canScan, onscanned (called with the new result).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
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
      toast.success(`Scanned ${repositoryName(repository)}.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not scan the repository.';
    } finally {
      scanning = false;
    }
  }

  const paths = $derived(detection ? detectionPaths(detection) : []);
  const localeRows = $derived(
    detection
      ? [
          { label: 'App Store locales', values: detection.locales.ios },
          { label: 'Google Play locales', values: detection.locales.android },
        ].filter((row) => row.values.length > 0)
      : [],
  );
  const expoRows = $derived.by(() => {
    const expo = detection?.expo;
    if (!expo) return [];
    const rows: Array<[string, string]> = [];
    if (expo.name) rows.push(['Name', expo.name]);
    if (expo.slug) rows.push(['Slug', expo.slug]);
    if (expo.version) rows.push(['Version', expo.version]);
    if (expo.iosBundleIdentifier) rows.push(['iOS bundle identifier', expo.iosBundleIdentifier]);
    if (expo.androidPackage) rows.push(['Android package', expo.androidPackage]);
    if (expo.buildProfiles.length > 0) rows.push(['EAS build profiles', expo.buildProfiles.join(', ')]);
    if (expo.submitProfiles.length > 0) rows.push(['EAS submit profiles', expo.submitProfiles.join(', ')]);
    for (const config of expo.storeConfigs) {
      rows.push([
        config.profile ? `Store config (${config.profile})` : 'Store config',
        config.dynamic ? `${config.path} (a script, so its text cannot be read)` : config.path,
      ]);
    }
    return rows;
  });
</script>

<div class="stack loose">
  {#if error}
    <div class="stack">
      <Alert tone="error">{error}</Alert>
      {#if canScan}<div><Button icon="refresh" onclick={scan}>Try again</Button></div>{/if}
    </div>
  {/if}

  {#if scanning}
    <div class="card" role="status" aria-label="Scanning the repository">
      <div class="stack">
        <Skeleton width="40%" height="20px" />
        <Skeleton width="80%" height="14px" />
        <Skeleton width="60%" height="14px" />
        <p class="muted">Reading the file list from GitHub. This can take a few seconds.</p>
      </div>
    </div>
  {:else if detection === null}
    <div class="card">
      <EmptyState
        icon="search"
        title="Not scanned yet"
        description={canScan
          ? 'A scan lists the files in the repository and works out whether it uses fastlane, Expo or both. It only reads.'
          : 'Nobody has scanned this repository yet. A member, admin or owner can scan it.'}
      >
        {#snippet actions()}
          {#if canScan}<Button variant="primary" icon="search" onclick={scan}>Scan repository</Button>{/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <Card title="Project type" description={projectKindSummary(detection.kind)}>
      {#snippet actions()}
        {#if canScan}<Button icon="refresh" onclick={scan}>Scan again</Button>{/if}
      {/snippet}
      <dl class="facts">
        <div>
          <dt>Detected</dt>
          <dd><KindBadge kind={detection.kind} /></dd>
        </div>
        <div>
          <dt>Platforms</dt>
          <dd>{platformsSummary(detection)}</dd>
        </div>
        {#if repository.detectedAt}
          <div>
            <dt>Last scan</dt>
            <dd><time datetime={new Date(repository.detectedAt).toISOString()} title={fullTime(repository.detectedAt)}>{timeAgo(repository.detectedAt)}</time></dd>
          </div>
        {/if}
      </dl>
    </Card>

    {#if detection.warnings.length > 0}
      <Alert tone="warn" title={detection.warnings.length === 1 ? 'One thing to check' : 'Things to check'}>
        <ul class="plain">
          {#each detection.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if paths.length > 0 || localeRows.length > 0}
      <Card title="What was found" description="Folders and files the scan used.">
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
      <Card title="Expo" description="Read from app.json and eas.json. Nothing is run.">
        <dl class="facts stacked">
          {#each expoRows as [label, value] (label)}
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          {/each}
        </dl>
        {#if detection.expo?.dynamicConfig}
          <p class="hint">The Expo config is a script, so name, version and identifiers cannot be read without running it.</p>
        {/if}
      </Card>
    {/if}

    <section class="stack" aria-labelledby="evidence-title">
      <h3 id="evidence-title">Evidence</h3>
      {#if detection.evidence.length === 0}
        <p class="muted">No files that point to fastlane or Expo were found.</p>
      {:else}
        <div class="table-wrap">
          <table class="compact">
            <caption class="visually-hidden">Files that led to the detected project type</caption>
            <thead>
              <tr>
                <th scope="col">What was found</th>
                <th scope="col">File</th>
                <th scope="col">Platform</th>
                <th scope="col">Certainty</th>
              </tr>
            </thead>
            <tbody>
              {#each detection.evidence as item, i (i)}
                <tr>
                  <td>{item.fact}</td>
                  <td><code>{item.path}</code></td>
                  <td>{item.platform === 'ios' ? 'iOS' : item.platform === 'android' ? 'Android' : 'Both or neither'}</td>
                  <td>
                    <Badge tone={item.strength === 'definite' ? 'ok' : 'warn'}>{strengthLabel(item.strength)}</Badge>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="hint">Confirmed means a file states it. Likely is a reasonable reading and never changes the detected type.</p>
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
