<!--
  PlayCheck: "Check this release" for a Google Play release, drawn before the release is published (the Confirm step) and in the
  release dialog. Two kinds of checks side by side:
  - Local checks, from what this tool knows, no store call: release notes missing for a language that has a listing, notes over
    500 characters, a version code the track already holds or is lower than it, a share outside 0 to 100%, an empty release name,
    and what the state means (a draft goes to nobody, a rollout reaches a share, 100% is a completed release).
  - "Check with Google Play": asks Google whether it would REFUSE the release (an edit that is validated and deleted; nothing is saved
    or released). Google reports errors only. The result never says "no warnings": it says Google found no errors and that the Play
    Console may still show warnings (docs/adr/0025-play-release-checks.md).
  Props: api, workspaceId, app ({ id, name, platform }), track, codes (version codes), fraction (the share as a fraction, or null),
  source ('staged': staged values over the store draft, for the Confirm step; 'store': the store draft only, for the release dialog,
  because a release starts what the store holds). It reads the draft and the languages itself.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { playCheckMessage } from '../../../lib/core-text.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import T from '../../ui/T.svelte';
  import type { Api } from '../../../lib/api.ts';
  import { readCache } from '../../../lib/read-cache.ts';
  import {
    type PlayCheckAnswer,
    bodyKey,
    canCheck,
    checkBody,
    checkedLine,
    contextOf,
    localChecks,
    outcomeView,
    proposalOf,
    stateLine,
  } from '../../../lib/play-check.ts';
  import type { EditableRelease } from '../../../lib/release-candidates.ts';
  import { stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    app,
    track,
    codes,
    fraction,
    source,
  }: {
    api: Api;
    workspaceId: string;
    app: Pick<AppSummary, 'id' | 'name' | 'platform'>;
    track: string;
    codes: string[];
    fraction: number | null;
    source: 'staged' | 'store';
  } = $props();

  const uid = $props.id();

  let editable = $state<EditableRelease | null>(null);
  let listingLocales = $state<string[]>([]);
  let readFailed = $state(false);
  let checking = $state(false);
  let answer = $state<PlayCheckAnswer | null>(null);
  let answeredFor = $state('');
  let problem = $state('');
  let seq = 0;

  const view = $derived(source === 'staged' ? stagedStore.view(app.id) : null);
  const proposal = $derived(proposalOf({ source, track, codes, fraction, view, editable }));
  const context = $derived(contextOf(editable, listingLocales));
  const local = $derived(localChecks(proposal, context));
  const ready = $derived(canCheck(proposal));
  const body = $derived(checkBody(proposal));
  const stale = $derived(answer !== null && answeredFor !== bodyKey(body));
  const outcome = $derived(answer !== null ? outcomeView(answer) : null);
  const problems = $derived(local.filter((c) => c.severity === 'problem').length);

  async function read(force = false) {
    const mine = ++seq;
    readFailed = false;
    try {
      const [read, live] = await Promise.all([
        readCache.read({
          workspaceId,
          group: 'store',
          key: `editable/${app.id}/${track.trim()}`,
          force,
          load: () => api.releaseEditable(workspaceId, app.id, track.trim()),
        }),
        readCache
          .read({ workspaceId, group: 'listing', key: `live/${app.id}`, force, load: () => api.appListingLive(workspaceId, app.id) })
          .catch(() => null),
      ]);
      if (mine !== seq) return;
      editable = read.editable;
      if (live !== null) {
        const channel = live.channels.filter((c) => c.channel === 'editable')[0] ?? live.channels[0];
        listingLocales = channel ? Object.keys(channel.locales) : [];
      }
    } catch {
      if (mine !== seq) return;
      editable = null;
      readFailed = true;
    }
  }

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}/${track.trim()}/${source}`;
    if (key === shownFor) return;
    shownFor = key;
    untrack(() => {
      answer = null;
      problem = '';
      if (source === 'staged') void stagedStore.load(api, workspaceId, app.id);
      void read();
    });
  });

  async function check() {
    if (checking || !ready.ok) return;
    checking = true;
    problem = '';
    const sent = body;
    try {
      const out = await api.checkPlayRelease(workspaceId, app.id, sent);
      answer = out.check;
      answeredFor = bodyKey(sent);
    } catch (e) {
      answer = null;
      problem = stagingError(e);
    } finally {
      checking = false;
    }
  }
</script>

<section class="check" aria-labelledby="{uid}-title" data-testid="play-check">
  <header class="head">
    <h4 id="{uid}-title">{t('release-stepper:pc.title')}</h4>
    <InfoTip label={t('release-stepper:pc.tipLabel')} text={t('release-stepper:pc.tipText')} />
  </header>

  <p class="muted small">{stateLine(proposal)}</p>

  {#if readFailed}
    <p class="muted small">
      {t('release-stepper:pc.readFailed')}
      <Button size="sm" variant="ghost" onclick={() => read(true)}>{t('release-stepper:pc.readAgain')}</Button>
    </p>
  {/if}

  {#if local.length === 0}
    <p class="small"><Badge tone="ok" icon="check">{t('release-stepper:pc.checkedHere')}</Badge> {t('release-stepper:pc.nothingToFix')}</p>
  {:else}
    <ul class="list" aria-label={t('release-stepper:pc.checksHere')}>
      {#each local as c (`${c.code}/${c.item ?? ''}`)}
        <li>
          <Badge tone={c.severity === 'problem' ? 'bad' : c.severity === 'warning' ? 'warn' : 'info'}>
            {c.severity === 'problem' ? t('release-stepper:pc.fix') : c.severity === 'warning' ? t('release-stepper:pc.check') : t('release-stepper:pc.note')}
          </Badge>
          <span>{playCheckMessage(c)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="row">
    <Button icon="shield" loading={checking} disabled={checking || !ready.ok} onclick={check}>{t('release-stepper:pc.checkWithGoogle')}</Button>
    {#if !ready.ok}<span class="muted small">{ready.reason}</span>{/if}
    {#if ready.ok && problems > 0}<span class="muted small">{t('release-stepper:pc.wouldRefuse', { count: problems })}</span>{/if}
  </div>
  <p class="muted small">{t('release-stepper:pc.asks')}</p>

  {#if problem}<Alert tone="error" title={t('release-stepper:pc.failed')}>{problem}</Alert>{/if}

  {#if answer !== null && outcome !== null}
    <div role="status" aria-live="polite" class="answer">
      <Alert tone={outcome.tone === 'ok' ? 'ok' : 'error'} title={outcome.title}>
        <p class="para">{checkedLine(answer)}</p>
        {#if outcome.findings.length > 0}
          <ul class="findings" aria-label={t('release-stepper:pc.reported')}>
            {#each outcome.findings as finding, i (i)}<li>{finding}</li>{/each}
          </ul>
        {/if}
        {#if outcome.rolloutNotice}<p class="para" data-testid="rollout-refused"><strong>{outcome.rolloutNotice}</strong></p>{/if}
        {#each outcome.lines as line (line)}<p class="para">{line}</p>{/each}
        {#if stale}<p class="para"><T key="release-stepper:pc.stale" /></p>{/if}
      </Alert>
    </div>
  {/if}
</section>

<style>
  .check {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  h4 {
    margin: 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .list,
  .findings {
    display: grid;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .list li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    font-size: var(--text-sm);
  }

  .findings {
    padding-left: var(--space-3);
    margin: var(--space-1) 0;
    list-style: disc;
    overflow-wrap: anywhere;
  }

  .para {
    margin: var(--space-1) 0 0;
  }
</style>
