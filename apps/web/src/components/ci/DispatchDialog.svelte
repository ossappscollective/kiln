<!--
  DispatchDialog: start a GitHub Actions workflow with `workflow_dispatch`, in two steps: the
  inputs (read from the workflow file, else typed as name=value lines), then a confirmation that
  says what is about to run. This tool never builds anything: it asks the team's own CI to.
  Props: api, workspaceId, repository, workflow, apps (the workspace's apps, to tie a run to one),
  onclose (called after the dialog closes), ondispatched (called with the run that was stored).
  Mount it when a workflow is chosen; unmount it on close, so every open starts clean.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    dispatchInputs,
    dispatchSummary,
    initialInputValues,
    inputProblems,
    parseFreeFormInputs,
    workflowKey,
    type InputValues,
  } from '../../lib/ci.ts';
  import { repositoryName } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, CiWorkflow, RepositorySummary, WorkflowInputs, WorkflowRun } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    repository,
    workflow,
    apps,
    onclose,
    ondispatched,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    workflow: CiWorkflow;
    apps: AppSummary[];
    onclose: () => void;
    ondispatched: (run: WorkflowRun) => void;
  } = $props();

  const uid = $props.id();
  const key = untrack(() => workflowKey(workflow));

  let open = $state(true);
  let step = $state<'form' | 'confirm'>('form');
  let loading = $state(true);
  let loadProblem = $state('');
  let info = $state<WorkflowInputs | null>(null);
  let ref = $state(untrack(() => repository.defaultBranch));
  let values = $state<InputValues>({});
  let freeText = $state('');
  let appId = $state('');
  let submitting = $state(false);
  let problem = $state('');
  /** Problems are shown after the first try to continue, not while the person is still typing. */
  let tried = $state(false);

  async function loadInputs() {
    loading = true;
    loadProblem = '';
    try {
      const read = await api.workflowInputs(workspaceId, repository.id, key);
      info = read;
      values = initialInputValues(read.parsed ? read.inputs : []);
    } catch (e) {
      info = null;
      loadProblem = e instanceof ApiError ? e.message : 'Could not read the workflow.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    untrack(() => void loadInputs());
  });

  const specs = $derived(info?.parsed ? info.inputs : []);
  /** The file could not be read: the person types name=value lines instead. */
  const freeForm = $derived(!info || !info.parsed);
  const free = $derived(parseFreeFormInputs(freeText));
  const problems = $derived(freeForm ? {} : inputProblems(specs, values));
  const refProblem = $derived(ref.trim() === '' ? 'Enter a branch or tag.' : '');
  const valid = $derived(refProblem === '' && (freeForm ? free.problems.length === 0 : Object.keys(problems).length === 0));
  const payload = $derived(freeForm ? free.inputs : dispatchInputs(specs, values));
  const linkable = $derived(apps.filter((a) => a.repositoryId === repository.id));
  const notDispatchable = $derived(info?.dispatchable === false);

  function next() {
    tried = true;
    if (!valid || notDispatchable) return;
    step = 'confirm';
  }

  async function run() {
    submitting = true;
    problem = '';
    try {
      const done = await api.dispatchWorkflow(workspaceId, repository.id, key, {
        ref: ref.trim(),
        inputs: payload,
        ...(appId ? { appId } : {}),
      });
      toast.success(
        done.runKnown
          ? `Started ${workflow.name}. It is listed under recent runs.`
          : `Asked GitHub to start ${workflow.name}. The run shows up under recent runs in a few seconds.`,
      );
      ondispatched(done.run);
      open = false;
    } catch (e) {
      // A timeout may still have started the run: the server says so, and that matters here.
      problem =
        e instanceof ApiError
          ? e.code === 'timeout' && typeof e.body.message === 'string'
            ? e.body.message
            : e.message
          : 'Could not start the workflow.';
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  bind:open
  size="md"
  title={step === 'form' ? `Run ${workflow.name}` : 'Run this workflow?'}
  description={step === 'form' ? 'Starts the workflow on GitHub with workflow_dispatch.' : undefined}
  dismissible={!submitting}
  {onclose}
>
  {#if step === 'form'}
    {#if loading}
      <div class="stack" role="status" aria-label="Reading the workflow inputs">
        <Skeleton width="40%" height="14px" />
        <Skeleton height="36px" />
        <Skeleton width="40%" height="14px" />
        <Skeleton height="36px" />
      </div>
    {:else}
      <form
        id="{uid}-form"
        class="stack"
        novalidate
        onsubmit={(event) => {
          event.preventDefault();
          next();
        }}
      >
        {#if loadProblem}
          <Alert tone="warn" title="Could not read the workflow file">
            {loadProblem} You can still start it by typing the inputs by hand.
          </Alert>
        {:else if notDispatchable}
          <Alert tone="error" title="This workflow cannot be started by hand">
            Its file has no <code>workflow_dispatch</code> trigger, so GitHub would refuse. Add the trigger to the workflow file first.
          </Alert>
        {:else if info && !info.parsed}
          <Alert tone="info" title="The inputs could not be read from the file">
            Type them as <code>name=value</code> lines, one per line. Leave it empty to start without inputs.
          </Alert>
        {/if}

        <TextField
          label="Branch or tag"
          bind:value={ref}
          error={tried ? refProblem || undefined : undefined}
          hint="The code the workflow runs on. Defaults to the repository's default branch."
          autocomplete="off"
          spellcheck={false}
        />

        {#if freeForm}
          <div class="field">
            <label for="{uid}-free">Inputs</label>
            <textarea id="{uid}-free" rows="4" bind:value={freeText} spellcheck="false" placeholder="build_number=241&#10;track=internal"></textarea>
            {#if tried && free.problems.length > 0}
              <ul class="problems" id="{uid}-free-problems">
                {#each free.problems as message (message)}<li>{message}</li>{/each}
              </ul>
            {/if}
          </div>
        {:else}
          {#each specs as spec (spec.name)}
            {@const id = `${uid}-in-${spec.name}`}
            {@const error = tried ? problems[spec.name] : undefined}
            {#if spec.type === 'boolean'}
              <div class="field">
                <label class="check" for={id}>
                  <input
                    {id}
                    type="checkbox"
                    checked={values[spec.name] === 'true'}
                    onchange={(e) => (values[spec.name] = e.currentTarget.checked ? 'true' : 'false')}
                  />
                  <span>{spec.name}</span>
                </label>
                {#if spec.description}<p class="hint">{spec.description}</p>{/if}
              </div>
            {:else if spec.type === 'choice'}
              <div class="field">
                <label for={id} class:required={spec.required}>{spec.name}</label>
                <select {id} bind:value={values[spec.name]} aria-invalid={error ? 'true' : undefined}>
                  {#if !spec.required}<option value="">(not set)</option>{/if}
                  {#each spec.options ?? [] as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
                {#if spec.description}<p class="hint">{spec.description}</p>{/if}
                {#if error}<p class="field-error">{error}</p>{/if}
              </div>
            {:else}
              <TextField
                label={spec.required ? `${spec.name} (required)` : spec.name}
                bind:value={values[spec.name]}
                hint={spec.description}
                {error}
                inputmode={spec.type === 'number' ? 'decimal' : undefined}
                autocomplete="off"
                spellcheck={false}
              />
            {/if}
          {:else}
            <p class="muted">This workflow takes no inputs.</p>
          {/each}
        {/if}

        {#if linkable.length > 0}
          <div class="field">
            <label for="{uid}-app">For app (optional)</label>
            <select id="{uid}-app" bind:value={appId}>
              <option value="">No app</option>
              {#each linkable as app (app.id)}
                <option value={app.id}>{app.name} ({app.platform === 'ios' ? 'iOS' : 'Android'})</option>
              {/each}
            </select>
            <p class="hint">Tied to an app, the run can be matched to that app's builds by the build number in its inputs.</p>
          </div>
        {/if}
      </form>
    {/if}
  {:else}
    <div class="stack">
      <p>{dispatchSummary({ workflow: key, ref: ref.trim(), repository: repositoryName(repository), inputs: payload })}</p>
      {#if Object.keys(payload).length > 0}
        <dl class="inputs">
          {#each Object.entries(payload) as [name, value] (name)}
            <dt><code>{name}</code></dt>
            <dd><code>{value}</code></dd>
          {/each}
        </dl>
      {/if}
      <Alert tone="info">
        This runs your CI with your CI's secrets and may build and upload. This tool does not build anything itself and does not publish to any store.
      </Alert>
      {#if problem}<Alert tone="error" title="Could not start the workflow">{problem}</Alert>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if step === 'form'}
      <Button disabled={submitting} onclick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" type="submit" form="{uid}-form" disabled={loading || notDispatchable}>Continue</Button>
    {:else}
      <Button disabled={submitting} onclick={() => (step = 'form')}>Back</Button>
      <Button variant="primary" icon="play" loading={submitting} onclick={run}>Run workflow</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  textarea {
    width: 100%;
    font-family: var(--font-mono);
  }

  .problems {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
    font-size: var(--text-xs);
    color: var(--bad-ink);
  }

  .inputs {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-4);
    margin: 0;
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .inputs dt,
  .inputs dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
