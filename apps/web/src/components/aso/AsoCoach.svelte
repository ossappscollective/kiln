<!--
  AsoCoach: the next steps for the ASO of one app, ranked, each with one link to the place to do it (add keywords,
  open the field in the listing, open the competitors). Worked out on the server from what is already stored (no store
  is read) by `buildCoach` in `@kiln/core`: no tracked keywords, ranks not checked lately, ranks that dropped,
  tracked keywords missing from the listing, a followed competitor ranking above, waste in the keyword field, unused
  characters, locales with no keyword text, no competitor followed. Every number is a count from the data; there is no
  search volume and no promise of a gain. Quiet: the first steps as one line each, the rest and the details behind a
  click. It draws nothing while it loads, when it failed, or when there is nothing to do.
  Props: api, workspaceId, app, version (changes when keywords or competitors changed, so it reads again),
  showPlatform? (name the platform in the heading, for a scope with several), visible? (steps shown before "Show all", default 4).
-->
<script lang="ts">
  import type { FitField } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AsoCoachResponse, asoErrorMessage } from '../../lib/aso/aso.ts';
  import { budgetFieldLabel, coachHref } from '../../lib/aso/budget.ts';
  import { coachWords } from '../../lib/core-text.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Section from '../ui/Section.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    app,
    version = 0,
    showPlatform = false,
    visible = 4,
  }: { api: Api; workspaceId: string; app: AppSummary; version?: number | undefined; showPlatform?: boolean | undefined; visible?: number | undefined } = $props();

  let data = $state<AsoCoachResponse | null>(null);
  let failed = $state('');
  let all = $state(false);
  let generation = 0;

  $effect(() => {
    void version;
    const space = workspaceId;
    const id = app.id;
    untrack(() => {
      const mine = ++generation;
      api
        .asoCoach(space, id)
        .then((r) => {
          if (mine === generation) {
            data = r;
            failed = '';
          }
        })
        .catch((e) => {
          if (mine === generation) failed = asoErrorMessage(e, t('aso:coach.error'));
        });
    });
  });

  const nextSteps = $derived(data?.actions ?? []);
  const words = (a: (typeof nextSteps)[number]) => coachWords(a, (field) => budgetFieldLabel(app.platform, field as FitField));
  const shown = $derived(all ? nextSteps : nextSteps.slice(0, visible));
</script>

{#if nextSteps.length > 0}
  <Section title={showPlatform ? t('aso:coach.titlePlatform', { platform: platformLabel(app.platform) }) : t('aso:coach.title')} key="coach.{app.platform}" count={t('aso:coach.count', { count: nextSteps.length })} summary={nextSteps[0] ? words(nextSteps[0]).title : ''}>
    {#snippet actions()}
      <InfoTip label={t('aso:coach.how')} align="end">
        <p class="tip">
          {t('aso:coach.howText')}
        </p>
      </InfoTip>
    {/snippet}
    <div class="coach">
    <ol class="steps">
      {#each shown as a (a.id)}
        {@const w = words(a)}
        <li>
          <span class="pos" aria-hidden="true">{a.position}</span>
          <div class="what">
            <strong>{w.title}</strong>
            {#if a.items.length === 0}
              <span class="muted detail">{w.detail}</span>
            {:else}
              <Disclosure summary={t('aso:coach.details')} stateKey="aso.coach.{app.id}.{a.id}">
                <p class="detail muted">{w.detail}</p>
                <ul class="items">
                  {#each w.items as item, i (i)}<li>{item}</li>{/each}
                </ul>
                {#if a.more > 0}<p class="muted more">{t('aso:coach.more', { count: a.more })}</p>{/if}
              </Disclosure>
            {/if}
          </div>
          <Button size="sm" href={coachHref(a.link, app.id, app.platform)}>{w.linkLabel}</Button>
        </li>
      {/each}
    </ol>
    {#if nextSteps.length > visible}
      <div><Button size="sm" variant="link" onclick={() => (all = !all)}>{all ? t('aso:coach.showFewer') : t('aso:coach.showAll', { count: nextSteps.length })}</Button></div>
    {/if}
    </div>
  </Section>
{/if}

<style>
  .coach {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .tip {
    margin: 0;
  }

  .steps {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .steps > li {
    display: grid;
    grid-template-columns: 1.5rem minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: start;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  .steps > li:first-child {
    border-top: 0;
  }

  .pos {
    color: var(--muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    padding-top: var(--space-1);
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .detail {
    margin: 0;
    font-size: var(--text-sm);
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    list-style: none;
  }

  .more {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
