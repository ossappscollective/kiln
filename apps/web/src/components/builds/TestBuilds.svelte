<!--
  TestBuilds: builds you can try on a device before publishing. The CI artifacts of the runs of one app (zips a workflow uploaded:
  IPA, APK, AAB, Mac builds) and the builds the last store sync saw (TestFlight, Google Play tracks), newest first, with the
  source, size, age and expiry, and what to do to install each one. Downloads go through this server and are off until an
  administrator switches them on; while off, no download button is drawn and the page says why. Nothing here changes GitHub or a store.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished, so this reloads).
  The address may carry `?build=<number>` (from the release stepper): that build is highlighted and the filters show it.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { parseViewPath } from '../../lib/app-scope.ts';
  import {
    type BuildFilters,
    type BuildRow,
    type BuildsList,
    type InternalSharingConfig,
    applyFilters,
    canOfferShare,
    defaultFilters,
    downloadBlocker,
    expiryText,
    hiddenBy,
    humanSize,
    installGuide,
    kindLabel,
    rowsOf,
    statusLine,
    testflightNote,
    testflightView,
  } from '../../lib/builds.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import DownloadDialog from './DownloadDialog.svelte';
  import InstallGuide from './InstallGuide.svelte';
  import InternalShareDialog from './InternalShareDialog.svelte';
  import PhoneLinkDialog from './PhoneLinkDialog.svelte';
  import TestFlightLinks from './TestFlightLinks.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const mayRead = $derived(can(role, 'builds.read'));

  let data = $state<BuildsList | null>(null);
  let loading = $state(true);
  let loadProblem = $state('');
  let filters = $state<BuildFilters>({ ...defaultFilters });
  let now = $state(Date.now());
  let downloadRow = $state<BuildRow | null>(null);
  let phoneRow = $state<BuildRow | null>(null);
  let shareRow = $state<BuildRow | null>(null);
  // Google Play internal app sharing: the button exists only when the server switch is on and this role may share. A failed read hides it.
  let sharing = $state<InternalSharingConfig | null>(null);

  const focus = $derived(parseViewPath(address.hash).query.get('build'));
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await api.buildArtifacts(workspaceId, app.id);
      if (mine !== generation) return;
      data = read;
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      data = null;
      loadProblem = e instanceof ApiError ? e.message : 'Could not load the builds.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    if (mayRead) untrack(() => void load());
  });

  $effect(() => {
    const id = workspaceId;
    sharing = null;
    if (!mayRead || !can(role, 'builds.share')) return;
    let current = true;
    api.internalSharingConfig(id).then(
      (config) => {
        if (current) sharing = config;
      },
      () => {},
    );
    return () => {
      current = false;
    };
  });

  const rows = $derived(data ? rowsOf(data) : []);
  // A build named in the address is always shown, whatever the filters hide.
  const shown = $derived(
    applyFilters(rows, focus ? { ...filters, hideExpired: false, hideOther: false, platform: 'all', source: 'all' } : filters),
  );
  const hidden = $derived(hiddenBy(rows, filters));
  const status = $derived(data ? statusLine(data) : null);
  const flightNote = $derived(data ? testflightNote(data) : null);
  let statusOpen = $state(false);
  // The install steps of one row, opened by its Install button.
  let installKey = $state<string | null>(null);
  const isFocus = (row: BuildRow) => focus !== null && row.store?.buildNumber === focus;
  const platforms = $derived(Array.from(new Set(rows.map((r) => r.platform).filter((p): p is NonNullable<typeof p> => p !== null))));
</script>

<div class="stack">
  <div class="toolbar">
    <p class="muted text-sm">
      Builds to try on a device before you publish: what your CI built, and what the stores hold for testers.
      <InfoTip label="About test builds" width="26rem">
        <p>CI builds are the zips your workflows upload as artifacts. GitHub keeps them for a limited time (90 days unless your workflow or repository says otherwise).</p>
        <p>The type of a CI build (IPA, APK, AAB) is a guess from the artifact name. Store builds come from the last sync of the app.</p>
      </InfoTip>
    </p>
    <Button size="sm" icon="refresh" loading={loading} onclick={() => void load()}>Read again</Button>
  </div>

  {#if !mayRead}
    <Alert tone="info" title="Test builds need the member role">Viewers can see the app and its releases. Ask an admin for the member role to list and download builds.</Alert>
  {:else if loading && !data}
    <div role="status" aria-label="Reading the builds" class="stack">
      <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
    </div>
  {:else if loadProblem}
    <Alert tone="error" title="Could not load the builds">
      {loadProblem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>Try again</Button></div>
    </Alert>
  {:else if data}
    {#if status}
      <div class="status {status.tone}" role={status.tone === 'error' ? 'alert' : 'status'}>
        <span class="status-line">
          <Icon name={status.tone === 'info' ? 'info' : 'alert-triangle'} size={16} />
          <span class="status-text">{status.text}</span>
          <button type="button" class="link-button" aria-expanded={statusOpen} aria-controls="builds-status-details" onclick={() => (statusOpen = !statusOpen)}>
            Details
          </button>
        </span>
        {#if statusOpen}
          <div id="builds-status-details" class="status-details">
            {#each status.details as d (d.title)}
              <p><strong>{d.title}.</strong> {d.body}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if rows.length > 0}
      <div class="filters" role="group" aria-label="Filter builds">
        <label class="inline">
          <span class="muted text-sm">Platform</span>
          <select bind:value={filters.platform}>
            <option value="all">All</option>
            {#each platforms as p (p)}<option value={p}>{p === 'ios' ? 'iOS' : p === 'macos' ? 'macOS' : 'Android'}</option>{/each}
          </select>
        </label>
        <label class="inline">
          <span class="muted text-sm">Source</span>
          <select bind:value={filters.source}>
            <option value="all">CI and store</option>
            <option value="ci">CI runs</option>
            <option value="store">Store (TestFlight, Play)</option>
          </select>
        </label>
        <label class="inline"><input type="checkbox" bind:checked={filters.hideExpired} /> <span>Hide expired</span></label>
        <label class="inline"><input type="checkbox" bind:checked={filters.hideOther} /> <span>Hide reports and logs</span></label>
        {#if hidden > 0}<span class="muted text-sm" aria-live="polite">{hidden} hidden by the filters</span>{/if}
      </div>
    {/if}

    {#if shown.length === 0}
      <EmptyState icon="smartphone" title={rows.length === 0 ? 'No builds to test yet' : 'Nothing matches the filters'} description={rows.length === 0 ? 'Run a workflow that uploads the build as an artifact (actions/upload-artifact), or sync the app so its store builds appear. CI builds show here for the runs linked to this app.' : 'Change the filters above to see the other builds.'} />
    {:else}
      <Section title="Test builds" key="test-builds" count={shown.length} flush>
        {#if flightNote}
          <p class="flight-note muted text-sm" role="status" title={flightNote.text}>
            <Icon name={flightNote.tone === 'warn' ? 'alert-triangle' : 'info'} size={14} />
            <span>{flightNote.short}</span>
            {#if flightNote.retry}<button type="button" class="link-button" disabled={loading} onclick={() => void load()}>Retry</button>{/if}
            <InfoTip label="About the TestFlight links" width="24rem" text={flightNote.text} />
          </p>
        {/if}
        <ul class="rows" aria-label="Builds of {app.name} to test">
          {#each shown as row (row.key)}
            {@const blocker = downloadBlocker(row, data)}
            {@const guide = installGuide(row)}
            <li class="row" class:focus={isFocus(row)} class:faded={row.expired}>
              <div class="main">
                <div class="head">
                  <span class="line">
                    {#if row.platform}<PlatformBadge platform={row.platform} showLabel={false} />{/if}
                    <strong class="title">{row.title}</strong>
                    <Badge tone="neutral">{kindLabel(row.kind)}</Badge>
                  </span>
                  <Badge tone={row.state.tone === 'neutral' ? 'neutral' : row.state.tone} dot>{row.state.label}</Badge>
                </div>
                <div class="meta muted text-sm">
                  <span class="src">
                    <Icon name={row.source === 'ci' ? 'pipeline' : 'store'} size={13} />
                    {row.source === 'ci' ? 'CI' : 'Store'}
                  </span>
                  {#if row.source === 'ci' && row.runUrl}
                    <a href={row.runUrl} target="_blank" rel="noopener noreferrer">{row.detail}<Icon name="external-link" size={12} /><span class="visually-hidden"> (opens in a new tab)</span></a>
                  {:else if row.detail}<span>{row.detail}</span>{/if}
                  {#if row.sizeBytes !== null}<span>{humanSize(row.sizeBytes)}</span>{/if}
                  {#if row.at !== null}<time datetime={new Date(row.at).toISOString()} title={fullTime(row.at)}>{timeAgo(row.at, now)}</time>{:else}<span>Age unknown</span>{/if}
                  {#if expiryText(row, now) !== ''}<span>{expiryText(row, now)}</span>{/if}
                  {#if row.artifact?.guessed && row.kind !== 'other'}<span>Type guessed from the name</span>{/if}
                </div>
                {#if row.source === 'store' && row.store}
                  {@const tf = testflightView(data, row.store)}
                  {#if tf.kind !== 'hidden'}<TestFlightLinks view={tf} />{/if}
                {/if}
              </div>
              <div class="buttons">
                {#if row.artifact && blocker === null}
                  <Button size="sm" icon="download" onclick={() => (downloadRow = row)}>Download</Button>
                  {#if guide.qr}<Button size="sm" icon="qr" onclick={() => (phoneRow = row)}>Phone</Button>{/if}
                {:else if row.artifact}
                  <InfoTip label="Why this cannot be downloaded" icon="lock" text={blocker ?? ''} align="end" />
                {/if}
                {#if canOfferShare(row, sharing)}
                  <Button size="sm" icon="upload" onclick={() => (shareRow = row)}>Share to device</Button>
                {/if}
                {#if guide.link}
                  <Button size="sm" icon="external-link" href={guide.link.href} target="_blank">{guide.link.label}</Button>
                {/if}
                <Button
                  size="sm"
                  icon="smartphone"
                  aria-expanded={installKey === row.key}
                  aria-controls="install-{row.key}"
                  onclick={() => (installKey = installKey === row.key ? null : row.key)}
                >
                  Install
                </Button>
              </div>
              {#if installKey === row.key}
                <div id="install-{row.key}" class="install"><InstallGuide {guide} /></div>
              {/if}
            </li>
          {/each}
        </ul>
      </Section>
      {#if data.truncated}<p class="muted text-sm">Only the newest artifacts of the repository were read.</p>{/if}
      {#if data.hiddenArtifacts > 0}<p class="muted text-sm">{data.hiddenArtifacts} other artifact{data.hiddenArtifacts === 1 ? '' : 's'} of this repository belong to other runs or platforms and are not shown.</p>{/if}
    {/if}
  {/if}
</div>

{#if downloadRow && data}
  <DownloadDialog {workspaceId} appId={app.id} row={downloadRow} onclose={() => (downloadRow = null)} />
{/if}
{#if shareRow && data}
  <InternalShareDialog {api} {workspaceId} appId={app.id} row={shareRow} onclose={() => (shareRow = null)} />
{/if}
{#if phoneRow && data}
  <PhoneLinkDialog {api} {workspaceId} appId={app.id} row={phoneRow} onclose={() => (phoneRow = null)} />
{/if}

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .toolbar p {
    margin: 0;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    align-items: center;
  }

  .inline {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  /* One quiet line for the whole page: downloads off and a CI problem, with the long words behind "Details". */
  .status {
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--info-bg);
    color: var(--info-ink);
  }

  .status.warn {
    background: var(--warn-bg);
    color: var(--warn-ink);
  }

  .status.error {
    background: var(--bad-bg, var(--warn-bg));
    color: var(--bad-ink, var(--warn-ink));
  }

  .status-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .status-text {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .status-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .status-details p {
    margin: 0;
  }

  .link-button {
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .link-button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .flight-note {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-4);
    margin: 0;
    border-bottom: 1px solid var(--line);
  }

  /* A build: the name and the state on one line, the rest in one muted line below, the actions after. They wrap, they do not stack by force. */
  .rows {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
  }

  .row + .row {
    border-top: 1px solid var(--line);
  }

  .main {
    display: flex;
    flex: 1 1 22rem;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: nowrap;
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

  .title {
    overflow-wrap: anywhere;
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

  .src {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .buttons {
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .install {
    flex: 1 1 100%;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }

  .faded {
    opacity: 0.7;
  }

  .row.focus {
    background: var(--accent-soft, var(--surface-sunken));
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
