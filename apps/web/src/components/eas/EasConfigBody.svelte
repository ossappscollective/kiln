<!--
  EasConfigBody: the inside of the EAS configuration card. Reads `GET /apps/{appId}/eas-config` when it is drawn (the card draws it
  only while open) and on "Read again". Shows the build profiles (distribution and channel as chips, what a profile extends, the names of
  its env variables, never values), the submit profiles, the versions and update setup of the app config, and the findings with a tone.
  An app whose repository has no eas.json gets an empty state with the reason, not an error.
  Props: api, workspaceId, app, onread? (called with the view and the state, for the collapsed summary).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    badgeTone,
    buildChips,
    emptyState,
    envText,
    extendsText,
    findingsHeadline,
    readCaption,
    runtimeLines,
    severityLabel,
    sortFindings,
    submitLines,
    updatesText,
    versionSourceText,
  } from '../../lib/eas/eas-config.ts';
  import type { AppSummary, EasConfigView, EasSeverity } from '../../lib/types.ts';
  import type { IconName } from '../../lib/icons.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    app,
    onread,
  }: {
    api: Api;
    workspaceId: string;
    app: AppSummary;
    onread?: ((view: EasConfigView | null, state: 'idle' | 'loading' | 'error') => void) | undefined;
  } = $props();

  let view = $state<EasConfigView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let now = $state(Date.now());
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    onread?.(view, 'loading');
    try {
      const read = await api.easConfig(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
      now = Date.now();
      onread?.(read, 'idle');
    } catch (e) {
      if (mine !== generation) return;
      problem = e instanceof ApiError ? e.message : 'Could not read the EAS configuration.';
      onread?.(view, 'error');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    untrack(() => {
      view = null;
      void load();
    });
  });

  const severityIcon: Record<EasSeverity, IconName> = { error: 'x-circle', warning: 'alert-triangle', info: 'info' };
  const findings = $derived(view ? sortFindings(view.findings) : []);
  const config = $derived(view?.config ?? null);
  const facts = $derived.by(() => {
    const out: { label: string; text: string; mono?: boolean }[] = [];
    if (!view || !config) return out;
    const expo = view.expoApp;
    out.push({ label: 'App version source', text: versionSourceText(config.cli) });
    if (config.cli.version) out.push({ label: 'EAS CLI version', text: config.cli.version, mono: true });
    if (expo) {
      if (expo.version) out.push({ label: 'App version', text: expo.version, mono: true });
      for (const line of runtimeLines(expo)) out.push({ label: line.label, text: line.text });
      out.push({ label: 'Expo Updates', text: updatesText(expo) });
      if (expo.easProjectId) out.push({ label: 'EAS project id', text: expo.easProjectId, mono: true });
      if (expo.iosBundleIdentifier) out.push({ label: 'Bundle identifier', text: expo.iosBundleIdentifier, mono: true });
      if (expo.androidPackage) out.push({ label: 'Package name', text: expo.androidPackage, mono: true });
    }
    return out;
  });
</script>

<div class="stack loose" aria-busy={loading}>
  {#if loading && !view}
    <div class="stack" role="status" aria-label="Reading eas.json">
      <Skeleton width="70%" height="16px" />
      <Skeleton width="55%" height="16px" />
      <Skeleton width="62%" height="16px" />
    </div>
  {:else if problem && !view}
    <div class="stack">
      <Alert tone="error" title="Could not read the EAS configuration">{problem}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if view}
    {#if problem}<Alert tone="warn" title="Could not read it again">{problem} What is shown was read earlier.</Alert>{/if}
    <div class="row caption">
      {#if view.found}<span class="muted text-sm">{readCaption(view, now)}</span>{/if}
      <span class="spacer"></span>
      <Button size="sm" icon="refresh" loading={loading} onclick={load}>Read again</Button>
    </div>

    {#if !view.found}
      {@const empty = emptyState(view)}
      <EmptyState icon="file-text" title={empty.title} description={empty.description} />
    {:else if config === null}
      <Alert tone="error" title="eas.json could not be read">The file was found but its content could not be turned into profiles. The checks below say why.</Alert>
    {:else}
      <section class="stack tight" aria-labelledby="eas-build-heading-{app.id}">
        <h4 id="eas-build-heading-{app.id}">Build profiles <span class="muted count">{config.build.length}</span></h4>
        {#if config.build.length === 0}
          <p class="muted">No build profiles are defined.</p>
        {:else}
          <div class="table-wrap">
            <table class="compact">
              <caption class="visually-hidden">Build profiles of eas.json</caption>
              <thead>
                <tr>
                  <th scope="col">Profile</th>
                  <th scope="col">Settings</th>
                  <th scope="col">Env variables</th>
                </tr>
              </thead>
              <tbody>
                {#each config.build as profile (profile.name)}
                  {@const chips = buildChips(profile)}
                  {@const inherits = extendsText(profile)}
                  <tr>
                    <td>
                      <span class="cell"><strong>{profile.name}</strong>{#if inherits}<span class="muted text-sm">{inherits}</span>{/if}</span>
                    </td>
                    <td>
                      {#if chips.length === 0}
                        <span class="muted">Defaults</span>
                      {:else}
                        <span class="chips">
                          {#each chips as chip (chip.text)}<Badge tone={chip.tone}>{chip.text}</Badge>{/each}
                        </span>
                      {/if}
                    </td>
                    <td><span class="text-sm" class:muted={profile.envNames.length === 0}>{envText(profile.envNames)}</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section class="stack tight" aria-labelledby="eas-submit-heading-{app.id}">
        <h4 id="eas-submit-heading-{app.id}">Submit profiles <span class="muted count">{config.submit.length}</span></h4>
        {#if config.submit.length === 0}
          <p class="muted">No submit profiles are defined.</p>
        {:else}
          <ul class="plain stack tight">
            {#each config.submit as profile (profile.name)}
              {@const lines = submitLines(profile)}
              {@const inherits = extendsText(profile)}
              <li class="submit">
                <span class="cell">
                  <strong>{profile.name}</strong>
                  {#if inherits}<span class="muted text-sm">{inherits}</span>{/if}
                </span>
                {#if lines.length === 0}
                  <span class="muted text-sm">No store section.</span>
                {:else}
                  {#each lines as line (line.label)}
                    <span class="text-sm"><span class="muted">{line.label}:</span> {line.text}</span>
                  {/each}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if facts.length > 0}
        <section class="stack tight" aria-labelledby="eas-versions-heading-{app.id}">
          <h4 id="eas-versions-heading-{app.id}">Versions and updates</h4>
          <dl class="facts">
            {#each facts as fact (fact.label)}
              <dt class="muted">{fact.label}</dt>
              <dd class:mono={fact.mono}>{fact.text}</dd>
            {/each}
          </dl>
        </section>
      {/if}
    {/if}

    {#if findings.length > 0}
      <section class="stack tight" aria-labelledby="eas-checks-heading-{app.id}">
        <h4 id="eas-checks-heading-{app.id}">Checks <span class="muted count">{findingsHeadline(findings)}</span></h4>
        <ul class="plain stack tight">
          {#each findings as finding, i (i)}
            <li class="finding">
              <Badge tone={badgeTone(finding.severity)} icon={severityIcon[finding.severity]}>{severityLabel(finding.severity)}</Badge>
              <span class="what">
                {finding.message}
                {#if finding.profile}<span class="muted text-sm"> Profile {finding.profile}.</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {:else if view.found && config !== null}
      <p class="muted text-sm">No problems found in eas.json.</p>
    {/if}
  {/if}
</div>

<style>
  h4 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }

  .count {
    margin-left: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .caption {
    align-items: center;
    gap: var(--space-3);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .submit {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    grid-template-columns: minmax(10rem, max-content) 1fr;
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt,
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .finding {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .finding :global(.badge) {
    flex: none;
  }

  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 40rem) {
    .facts {
      grid-template-columns: 1fr;
    }
  }
</style>
