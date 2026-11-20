<!--
  AsoCoach: the next steps for the ASO of one app, ranked, each with one link to the place to do it (add keywords,
  open the field in the listing, open the competitors). Worked out on the server from what is already stored (no store
  is read) by `buildCoach` in `@mrm/core`: no tracked keywords, ranks not checked lately, ranks that dropped,
  tracked keywords missing from the listing, a followed competitor ranking above, waste in the keyword field, unused
  characters, locales with no keyword text, no competitor followed. Every number is a count from the data; there is no
  search volume and no promise of a gain. Quiet: the first steps as one line each, the rest and the details behind a
  click. It draws nothing while it loads, when it failed, or when there is nothing to do.
  Props: api, workspaceId, app, version (changes when keywords or competitors changed, so it reads again),
  showPlatform? (name the platform in the heading, for a scope with several), visible? (steps shown before "Show all", default 4).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AsoCoachResponse, asoErrorMessage } from '../../lib/aso/aso.ts';
  import { coachHref } from '../../lib/aso/budget.ts';
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
          if (mine === generation) failed = asoErrorMessage(e, 'Could not work out the next steps.');
        });
    });
  });

  const nextSteps = $derived(data?.actions ?? []);
  const shown = $derived(all ? nextSteps : nextSteps.slice(0, visible));
</script>

{#if nextSteps.length > 0}
  <Section title={`Next steps${showPlatform ? ` · ${platformLabel(app.platform)}` : ''}`} key="coach.{app.platform}" count={`${nextSteps.length} ${nextSteps.length === 1 ? 'step' : 'steps'}`} summary={nextSteps[0]?.title ?? ''}>
    {#snippet actions()}
      <InfoTip label="How the next steps are chosen" align="end">
        <p class="tip">
          Worked out from what this server already holds: your tracked keywords and their ranks, the stored listing, and the competitors you follow. They are
          ordered by what blocks the rest, then by what moved, then by tidying up. Nothing here is a search volume or a promise of more downloads, and
          nothing is changed for you. Which fields a store searches is unverified.
        </p>
      </InfoTip>
    {/snippet}
    <div class="coach">
    <ol class="steps">
      {#each shown as a (a.id)}
        <li>
          <span class="pos" aria-hidden="true">{a.position}</span>
          <div class="what">
            <strong>{a.title}</strong>
            {#if a.items.length === 0}
              <span class="muted detail">{a.detail}</span>
            {:else}
              <Disclosure summary="Details" stateKey="aso.coach.{app.id}.{a.id}">
                <p class="detail muted">{a.detail}</p>
                <ul class="items">
                  {#each a.items as item, i (i)}<li>{item}</li>{/each}
                </ul>
                {#if a.more > 0}<p class="muted more">and {a.more} more</p>{/if}
              </Disclosure>
            {/if}
          </div>
          <Button size="sm" href={coachHref(a.link, app.id, app.platform)}>{a.link.label}</Button>
        </li>
      {/each}
    </ol>
    {#if nextSteps.length > visible}
      <div><Button size="sm" variant="link" onclick={() => (all = !all)}>{all ? 'Show fewer' : `Show all ${nextSteps.length}`}</Button></div>
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
