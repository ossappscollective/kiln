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
    buildProfileTotal,
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
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, EasConfigView, EasSeverity } from '../../lib/types.ts';
  import type { IconName } from '../../lib/icons.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

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
  const clock = useNow();
  const now = $derived(clock.value);
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
      clock.touch();
      onread?.(read, 'idle');
    } catch (e) {
      if (mine !== generation) return;
      problem = e instanceof ApiError ? e.message : t('eas:config.body.readError');
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
    out.push({ label: t('eas:config.fact.versionSource'), text: versionSourceText(config.cli) });
    if (config.cli.version) out.push({ label: t('eas:config.fact.cliVersion'), text: config.cli.version, mono: true });
    if (expo) {
      if (expo.version) out.push({ label: t('eas:config.fact.appVersion'), text: expo.version, mono: true });
      for (const line of runtimeLines(expo)) out.push({ label: line.label, text: line.text });
      out.push({ label: t('eas:config.fact.expoUpdates'), text: updatesText(expo) });
      if (expo.easProjectId) out.push({ label: t('eas:config.fact.projectId'), text: expo.easProjectId, mono: true });
      if (expo.iosBundleIdentifier) out.push({ label: t('eas:config.fact.bundleId'), text: expo.iosBundleIdentifier, mono: true });
      if (expo.androidPackage) out.push({ label: t('eas:config.fact.packageName'), text: expo.androidPackage, mono: true });
    }
    return out;
  });
</script>

<div class="stack loose" aria-busy={loading}>
  {#if loading && !view}
    <div class="stack" role="status" aria-label={t('eas:config.collapsed.loading')}>
      <Skeleton width="70%" height="16px" />
      <Skeleton width="55%" height="16px" />
      <Skeleton width="62%" height="16px" />
    </div>
  {:else if problem && !view}
    <div class="stack">
      <Alert tone="error" title={t('eas:config.body.readErrorTitle')}>{problem}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('eas:config.body.tryAgain')}</Button></div>
    </div>
  {:else if view}
    {#if problem}<Alert tone="warn" title={t('eas:config.body.rereadErrorTitle')}>{t('eas:config.body.rereadError', { problem })}</Alert>{/if}
    <div class="row caption">
      {#if view.found}<span class="muted text-sm">{readCaption(view, now)}</span>{/if}
      <span class="spacer"></span>
      <Button size="sm" icon="refresh" loading={loading} onclick={load}>{t('eas:config.body.readAgain')}</Button>
    </div>

    {#if !view.found}
      {@const empty = emptyState(view)}
      <EmptyState icon="file-text" title={empty.title} description={empty.description} />
    {:else if config === null}
      <Alert tone="error" title={t('eas:config.empty.unreadableTitle')}>{t('eas:config.body.unreadableDesc')}</Alert>
    {:else}
      {@const profileTotal = buildProfileTotal(config)}
      <section class="stack tight" aria-labelledby="eas-build-heading-{app.id}">
        <h4 id="eas-build-heading-{app.id}">{t('eas:config.body.buildProfiles')} <span class="muted count">{profileTotal}</span></h4>
        {#if profileTotal === 0}
          <p class="muted">{t('eas:config.body.noBuildProfiles')}</p>
        {:else}
          <div class="table-wrap">
            <table class="compact">
              <caption class="visually-hidden">{t('eas:config.body.buildCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('eas:config.body.colProfile')}</th>
                  <th scope="col">{t('eas:config.body.colSettings')}</th>
                  <th scope="col">{t('eas:config.body.colEnv')}</th>
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
                        <span class="muted">{t('eas:config.body.defaults')}</span>
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
        <h4 id="eas-submit-heading-{app.id}">{t('eas:config.body.submitProfiles')} <span class="muted count">{config.submit.length}</span></h4>
        {#if config.submit.length === 0}
          <p class="muted">{t('eas:config.body.noSubmitProfiles')}</p>
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
                  <span class="muted text-sm">{t('eas:config.body.noStoreSection')}</span>
                {:else}
                  {#each lines as line (line.label)}
                    <span class="text-sm"><span class="muted">{t('eas:config.body.lineLabel', { label: line.label })}</span> {line.text}</span>
                  {/each}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if facts.length > 0}
        <section class="stack tight" aria-labelledby="eas-versions-heading-{app.id}">
          <h4 id="eas-versions-heading-{app.id}">{t('eas:config.body.versions')}</h4>
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
        <h4 id="eas-checks-heading-{app.id}">{t('eas:config.body.checks')} <span class="muted count">{findingsHeadline(findings)}</span></h4>
        <ul class="plain stack tight">
          {#each findings as finding, i (i)}
            <li class="finding">
              <Badge tone={badgeTone(finding.severity)} icon={severityIcon[finding.severity]}>{severityLabel(finding.severity)}</Badge>
              <span class="what">
                {finding.message}
                {#if finding.profile}<span class="muted text-sm"> {t('eas:config.body.findingProfile', { profile: finding.profile })}</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {:else if view.found && config !== null}
      <p class="muted text-sm">{t('eas:config.body.noProblems')}</p>
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
