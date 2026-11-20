<!--
  NewPlan: starts a plan for one version of an app: which platforms it covers, a target date and a
  checklist template to start from. A plan is our own planning data, so creating one does not
  contact a store. Props: api, workspaceId, app (AppSummary), version, hasPlans (the app already has
  a plan for another version, so the routine checklist is the default), oncreated (called with the plan).
-->
<script lang="ts">
  import type { PlanPlatform } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { planErrorMessage, planPlatformChoices } from '../../lib/release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ChecklistTemplate, PlanDetail } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    app,
    version,
    hasPlans,
    oncreated,
  }: {
    api: Api;
    workspaceId: string;
    app: AppSummary;
    version: string;
    hasPlans: boolean;
    oncreated: (plan: PlanDetail) => void;
  } = $props();

  const uid = $props.id();

  const choices = $derived(planPlatformChoices(app));
  let platformKey = $state('both');
  let targetDate = $state('');
  let templateId = $state('');
  let templates = $state<ChecklistTemplate[]>([]);
  let busy = $state(false);
  let problem = $state('');

  const platform = $derived<PlanPlatform>(platformKey === 'both' ? null : app.platform);

  $effect(() => {
    void workspaceId;
    let live = true;
    api
      .checklistTemplates(workspaceId)
      .then((result) => {
        if (!live) return;
        templates = result.templates;
        // A first release gets the first-release checklist of its platform; later ones the short one.
        const preferred = hasPlans ? 'builtin:routine-update' : `builtin:first-${app.platform}`;
        templateId = templates.some((t) => t.id === preferred) ? preferred : '';
      })
      .catch(() => {
        if (live) templates = [];
      });
    return () => {
      live = false;
    };
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    problem = '';
    try {
      const result = await api.createPlan(workspaceId, app.id, {
        version,
        platform,
        ...(targetDate ? { targetDate } : {}),
        ...(templateId ? { templateId } : {}),
      });
      toast.success(`Started a plan for ${version}. Nothing was sent to a store.`);
      oncreated(result.plan);
    } catch (e) {
      problem = planErrorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card" aria-labelledby="{uid}-title">
  <div class="card-header">
    <div>
      <h2 id="{uid}-title">Plan this release</h2>
      <p>A checklist, release notes and a target date for version {version}. Nothing is sent to a store.</p>
    </div>
  </div>
  <form class="stack" onsubmit={create}>
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    <div class="field">
      <label for="{uid}-platform">Platforms</label>
      <select id="{uid}-platform" bind:value={platformKey}>
        {#each choices as choice (choice.label)}
          <option value={choice.value === null ? 'both' : choice.value}>{choice.label}</option>
        {/each}
      </select>
      <p class="hint">A plan for both platforms must fit the smaller notes limit (500 characters on Google Play).</p>
    </div>
    <div class="field">
      <label for="{uid}-date">Target date (optional)</label>
      <input id="{uid}-date" type="date" bind:value={targetDate} />
    </div>
    <div class="field">
      <label for="{uid}-template">Start the checklist from</label>
      <select id="{uid}-template" bind:value={templateId}>
        <option value="">An empty checklist</option>
        {#each templates as template (template.id)}
          <option value={template.id}>{template.name}{template.builtin ? ' (built in)' : ''} · {template.items.length} items</option>
        {/each}
      </select>
    </div>
    <div><Button type="submit" variant="primary" loading={busy}>Create plan</Button></div>
  </form>
</section>
