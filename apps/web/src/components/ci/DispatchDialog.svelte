<!--
  DispatchDialog: start a GitHub Actions workflow with `workflow_dispatch`, in two steps: the
  inputs (read from the workflow file, else typed as name=value lines), then a confirmation that
  says what is about to run (workflow, branch or tag, repository, app and every input with its value).
  The inputs are read from the workflow file at the chosen branch or tag, so a change of branch reads
  them again before anything can be started. This tool never builds anything: it asks the team's own CI to.
  The one dispatch dialog of the product: the repository page, the Workflows page, the app's Workflows page and the release
  start all open it with the same props (lib/dispatch-target.ts builds `target`), so they show the same fields. The apps of the
  workspace are read here (lib/nav-signals, cached and single-flight), to tie a run to some of them: "For apps", none is
  allowed and means the run is shown on every app of the repository.
  Props: api, workspaceId, target (dispatchTarget(): repository, workflow, platforms and appId to preselect an app, and hint? with
  the platforms in scope and a version: a platform or version input of the workflow that is still at its default is filled in
  on the first read, once; the person sees it in the form and can change it), onclose (called after the dialog closes), ondispatched (called with the run that was stored).
  Mount it when a workflow is chosen; unmount it on close, so every open starts clean.
-->
<script lang="ts">
  import { platformLabel } from '@kiln/core';
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
  } from '../../lib/ci/ci.ts';
  import { appsHint, appsInfo, appsLine, dispatchAppsBody, toggleApp } from '../../lib/ci/dispatch-apps.ts';
  import { type DispatchTarget, dispatchLinkableApps, dispatchPreselection } from '../../lib/ci/dispatch-target.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { repositoryName } from '../../lib/repositories.ts';
  import { dispatchHints } from '../../lib/start-release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import T from '../ui/T.svelte';
  import type { AppSummary, CiWorkflow, RepositorySummary, WorkflowInputs, WorkflowRun } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    target,
    onclose,
    ondispatched,
  }: {
    api: Api;
    workspaceId: string;
    target: DispatchTarget;
    onclose: () => void;
    ondispatched: (run: WorkflowRun) => void;
  } = $props();

  const uid = $props.id();
  const repository = untrack(() => target.repository);
  const workflow = untrack(() => target.workflow);
  const hint = untrack(() => target.hint);
  const key = untrack(() => workflowKey(workflow));

  let open = $state(true);
  let step = $state<'form' | 'confirm'>('form');
  let loading = $state(true);
  let loadProblem = $state('');
  let info = $state<WorkflowInputs | null>(null);
  let ref = $state(untrack(() => repository.defaultBranch));
  /** The branch or tag the inputs on screen were read at. A different `ref` means they must be read again first. */
  let inputsRef = $state(untrack(() => repository.defaultBranch));
  /** Set when the inputs were read again for a new branch: the person looks at them before continuing. */
  let reread = $state('');
  /** A timed-out dispatch may have started the run: the button then says so, and asks again only on purpose. */
  let maybeStarted = $state(false);
  /** The hint is applied to the first read only: later reads (another branch) keep what the person typed. */
  let hinted = false;
  let values = $state<InputValues>({});
  let freeText = $state('');
  /** The apps of the workspace, as read for the shell (the cache is used when fresh); none when this role may not read them. */
  let apps = $state<AppSummary[]>(untrack(() => navSignals.appsOf(workspaceId) ?? []));
  let appIds = $state<string[]>(untrack(() => dispatchPreselection(apps, target)));
  let appsTouched = false;
  let submitting = $state(false);
  let problem = $state('');
  /** Problems are shown after the first try to continue, not while the person is still typing. */
  let tried = $state(false);

  async function loadInputs(at: string = inputsRef) {
    loading = true;
    loadProblem = '';
    try {
      const read = await api.workflowInputs(workspaceId, repository.id, key, at === repository.defaultBranch ? undefined : at);
      info = read;
      // Keep what was typed for an input that still exists on the other branch.
      const fresh = initialInputValues(read.parsed ? read.inputs : []);
      const kept: InputValues = {};
      for (const name of Object.keys(fresh)) kept[name] = name in values && values[name] !== '' ? (values[name] as string) : (fresh[name] as string);
      if (hint && !hinted) {
        const suggested = dispatchHints(read.parsed ? read.inputs : [], hint);
        for (const name of Object.keys(suggested)) if (name in kept) kept[name] = suggested[name] as string;
      }
      hinted = true;
      values = kept;
      inputsRef = at;
    } catch (e) {
      info = null;
      loadProblem = e instanceof ApiError ? e.message : t('builds:dispatch.readFailed');
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    untrack(() => void loadInputs());
  });

  $effect(() => {
    untrack(() => {
      void navSignals.ensureApps(api, workspaceId).then((read) => {
        if (!read) return;
        apps = read;
        if (!appsTouched && appIds.length === 0) appIds = dispatchPreselection(read, target);
      });
    });
  });

  const specs = $derived(info?.parsed ? info.inputs : []);
  /** The file could not be read: the person types name=value lines instead. */
  const freeForm = $derived(!info || !info.parsed);
  const free = $derived(parseFreeFormInputs(freeText));
  const problems = $derived(freeForm ? {} : inputProblems(specs, values));
  const refProblem = $derived(ref.trim() === '' ? t('builds:dispatch.refRequired') : '');
  const valid = $derived(refProblem === '' && (freeForm ? free.problems.length === 0 : Object.keys(problems).length === 0));
  const payload = $derived(freeForm ? free.inputs : dispatchInputs(specs, values));
  const linkable = $derived(dispatchLinkableApps(apps, repository.id));
  const notDispatchable = $derived(info?.dispatchable === false);
  const appsText = $derived(appsLine(linkable, appIds));

  async function next() {
    tried = true;
    if (refProblem !== '') return;
    const wanted = ref.trim();
    if (wanted !== inputsRef) {
      // The workflow file may differ on this branch: read its inputs there, and let the person check them.
      await loadInputs(wanted);
      reread = wanted;
      tried = false;
      return;
    }
    if (!valid || notDispatchable) return;
    reread = '';
    step = 'confirm';
  }

  async function run() {
    submitting = true;
    problem = '';
    try {
      const done = await api.dispatchWorkflow(workspaceId, repository.id, key, {
        ref: ref.trim(),
        inputs: payload,
        ...dispatchAppsBody(appIds),
      });
      maybeStarted = false;
      toast.success(
        done.runKnown
          ? t('builds:dispatch.started', { name: workflow.name })
          : t('builds:dispatch.asked', { name: workflow.name }),
      );
      ondispatched(done.run);
      open = false;
    } catch (e) {
      // A timeout may still have started the run: the server says so, and that matters here.
      if (e instanceof ApiError && e.code === 'timeout') maybeStarted = true;
      problem =
        e instanceof ApiError
          ? e.code === 'timeout' && typeof e.body.message === 'string'
            ? e.body.message
            : e.message
          : t('builds:dispatch.startFailed');
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  bind:open
  size="md"
  title={step === 'form' ? t('builds:lead.runWorkflow', { name: workflow.name }) : t('builds:dispatch.confirmTitle')}
  description={step === 'form' ? t('builds:dispatch.description') : undefined}
  dismissible={!submitting}
  {onclose}
>
  {#if step === 'form'}
    {#if loading}
      <div class="stack" role="status" aria-label={t('builds:dispatch.readingInputs')}>
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
          <Alert tone="warn" title={t('builds:dispatch.fileUnreadableTitle')}>
            {t('builds:dispatch.fileUnreadable', { problem: loadProblem })}
          </Alert>
        {:else if notDispatchable}
          <Alert tone="error" title={t('builds:dispatch.notDispatchableTitle')}>
            <T key="builds:dispatch.notDispatchable" />
          </Alert>
        {:else if info && !info.parsed}
          <Alert tone="info" title={t('builds:dispatch.inputsUnreadableTitle')}>
            <T key="builds:dispatch.inputsUnreadable" />
          </Alert>
        {/if}

        <TextField
          label={t('builds:dispatch.ref')}
          bind:value={ref}
          error={tried ? refProblem || undefined : undefined}
          hint={t('builds:dispatch.refHint')}
          autocomplete="off"
          spellcheck={false}
        />

        {#if reread !== '' && reread === inputsRef && !loadProblem}
          <Alert tone="info">
            <T key="builds:dispatch.reread" params={{ ref: reread }} />
          </Alert>
        {/if}

        {#if freeForm}
          <div class="field">
            <label for="{uid}-free">{t('builds:dispatch.inputs')}</label>
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
                  {#if !spec.required}<option value="">{t('builds:dispatch.notSet')}</option>{/if}
                  {#each spec.options ?? [] as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
                {#if spec.description}<p class="hint">{spec.description}</p>{/if}
                {#if error}<p class="field-error">{error}</p>{/if}
              </div>
            {:else}
              <TextField
                label={spec.required ? t('builds:dispatch.requiredName', { name: spec.name }) : spec.name}
                bind:value={values[spec.name]}
                hint={spec.description}
                {error}
                inputmode={spec.type === 'number' ? 'decimal' : undefined}
                autocomplete="off"
                spellcheck={false}
              />
            {/if}
          {:else}
            <p class="muted">{t('builds:dispatch.noInputs')}</p>
          {/each}
        {/if}

        {#if linkable.length > 0}
          <fieldset class="field apps">
            <legend>
              {t('builds:dispatch.forApps')}
              <InfoTip label={t('builds:apps.infoLabel')} text={appsInfo()} />
            </legend>
            {#each linkable as app (app.id)}
              <label class="check">
                <input type="checkbox" checked={appIds.indexOf(app.id) >= 0} onchange={(e) => ((appsTouched = true), (appIds = toggleApp(linkable, appIds, app.id, e.currentTarget.checked)))} />
                <span>{app.name} ({platformLabel(app.platform)})</span>
              </label>
            {/each}
            <p class="hint">{appIds.length === 0 ? appsHint() : appsText}</p>
          </fieldset>
        {/if}
      </form>
    {/if}
  {:else}
    <div class="stack">
      <p>{dispatchSummary({ workflow: key, ref: ref.trim(), repository: repositoryName(repository), inputs: payload })}</p>
      {#if linkable.length > 0}<p class="muted">{appsText}</p>{/if}
      {#if Object.keys(payload).length > 0}
        <dl class="inputs">
          {#each Object.entries(payload) as [name, value] (name)}
            <dt><code>{name}</code></dt>
            <dd><code>{value}</code></dd>
          {/each}
        </dl>
      {/if}
      <Alert tone="info">
        {t('builds:dispatch.confirmNote')}
      </Alert>
      {#if problem}<Alert tone={maybeStarted ? 'warn' : 'error'} title={maybeStarted ? t('builds:dispatch.mayHaveStarted') : t('builds:dispatch.startFailedTitle')}>{problem}</Alert>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if step === 'form'}
      <Button disabled={submitting} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
      <Button variant="primary" type="submit" form="{uid}-form" disabled={loading || notDispatchable}>{t('builds:dispatch.continue')}</Button>
    {:else}
      <Button disabled={submitting} onclick={() => (step = 'form')}>{t('common:action.back')}</Button>
      <Button variant="primary" icon="play" loading={submitting} onclick={run}>{maybeStarted ? t('builds:dispatch.runAgain') : t('builds:dispatch.run')}</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .apps {
    padding: 0;
    margin: 0;
    border: 0;
  }

  .apps legend {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    padding: 0;
    margin-bottom: var(--space-1);
    font-weight: var(--weight-medium);
  }

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
