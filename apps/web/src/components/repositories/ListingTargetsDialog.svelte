<!--
  ListingTargetsDialog: the saved listing targets of a repository: add, edit and delete. A target
  is a name with an App Store folder and a Google Play folder (repository relative); it is how one
  repository with several apps, or a listing in an unusual place, is read. A folder that is set
  always wins over detection. Only admins and owners may change targets (repositories.write).
  Props: api, workspaceId, repository, targets (the saved ones, from the listing response), open
  (bindable), prefill? (a form to start with: opens on "add"), onchanged(info) called after a
  save or delete with the id to select, or the id that was deleted.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    emptyTargetForm,
    repositoryName,
    type TargetForm,
    type TargetFormField,
    targetFormFrom,
    targetFormProblems,
    targetInput,
    targetRootsSummary,
    targetServerProblems,
  } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ListingTargetView, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    repository,
    targets,
    open = $bindable(false),
    prefill,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    targets: ListingTargetView[];
    open?: boolean | undefined;
    prefill?: Partial<TargetForm> | undefined;
    onchanged: (info: { selectId?: string; deletedId?: string }) => void;
  } = $props();

  // `null`: the list; 'new': the form for a new target; an id: the form for that target.
  let editing = $state<string | null>(null);
  let form = $state<TargetForm>(emptyTargetForm());
  let problems = $state<Partial<Record<TargetFormField, string>>>({});
  let touched = $state(false);
  let saving = $state(false);
  let error = $state('');
  let confirmDelete = $state<string | null>(null);
  let deleting = $state(false);

  const uid = $props.id();

  // Opening starts at the list, or at the form when something to start from was given.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      error = '';
      confirmDelete = null;
      if (prefill && Object.keys(prefill).length > 0) startNew(prefill);
      else if (targets.length === 0) startNew();
      else editing = null;
    }
    wasOpen = open;
  });

  function startNew(from: Partial<TargetForm> = {}) {
    form = { ...emptyTargetForm(), ...from };
    problems = {};
    touched = false;
    error = '';
    editing = 'new';
  }

  function startEdit(target: ListingTargetView) {
    form = targetFormFrom(target);
    problems = {};
    touched = false;
    error = '';
    editing = target.id;
  }

  const live = $derived(touched ? targetFormProblems(form) : {});
  const shown = (field: TargetFormField) => problems[field] ?? live[field];

  async function save() {
    touched = true;
    const found = targetFormProblems(form);
    problems = {};
    if (Object.keys(found).length > 0 || saving || editing === null) return;
    saving = true;
    error = '';
    try {
      const body = targetInput(form);
      const result =
        editing === 'new'
          ? await api.createListingTarget(workspaceId, repository.id, body)
          : await api.updateListingTarget(workspaceId, repository.id, editing, body);
      toast.success(editing === 'new' ? `Saved the target ${result.target.name}.` : `Updated ${result.target.name}.`);
      editing = null;
      onchanged({ selectId: result.target.id });
    } catch (e) {
      if (e instanceof ApiError) {
        problems = targetServerProblems(e);
        if (Object.keys(problems).length === 0) error = e.message;
      } else error = 'Could not save the target.';
    } finally {
      saving = false;
    }
  }

  async function remove(target: ListingTargetView) {
    deleting = true;
    error = '';
    try {
      await api.deleteListingTarget(workspaceId, repository.id, target.id);
      toast.success(`Deleted the target ${target.label}.`);
      confirmDelete = null;
      onchanged({ deletedId: target.id });
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not delete the target.';
    } finally {
      deleting = false;
    }
  }
</script>

<Modal
  bind:open
  size="lg"
  title="Listing targets"
  description="Where the store listing of {repositoryName(repository)} lives. A folder you set here is always used instead of the detected one."
  dismissible={!saving && !deleting}
>
  <div class="stack loose">
    {#if error}<Alert tone="error">{error}</Alert>{/if}

    {#if editing === null}
      {#if targets.length === 0}
        <p class="muted">No saved targets yet.</p>
      {:else}
        <ul class="plain list" aria-label="Saved listing targets">
          {#each targets as target (target.id)}
            <li class="item">
              <div>
                <strong>{target.label}</strong>
                {#if target.app}<span class="muted"> · {target.app}</span>{/if}
                <p class="hint"><code>{targetRootsSummary(target.roots)}</code></p>
              </div>
              <div class="row actions">
                {#if confirmDelete === target.id}
                  <span>Delete {target.label}?</span>
                  <Button size="sm" variant="danger-solid" loading={deleting} onclick={() => remove(target)}>Delete</Button>
                  <Button size="sm" disabled={deleting} onclick={() => (confirmDelete = null)}>Keep</Button>
                {:else}
                  <Button size="sm" icon="edit" label="Edit {target.label}" onclick={() => startEdit(target)}>Edit</Button>
                  <Button size="sm" variant="danger" icon="trash" label="Delete {target.label}" onclick={() => (confirmDelete = target.id)}>Delete</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      <div><Button icon="plus" onclick={() => startNew()}>Add a target</Button></div>
    {:else}
      <form
        class="stack"
        aria-label={editing === 'new' ? 'Add a listing target' : 'Edit the listing target'}
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          id="{uid}-name"
          label="Name"
          bind:value={form.name}
          maxlength={60}
          autocomplete="off"
          required
          error={shown('name')}
          hint="Shown in the target list, for example the app's name."
        />
        <TextField
          id="{uid}-app"
          label="App id (optional)"
          bind:value={form.appId}
          autocomplete="off"
          error={shown('appId')}
          hint="The bundle id or package name, for your own reference."
        />
        <TextField
          id="{uid}-ios"
          label="App Store folder"
          bind:value={form.appStoreRoot}
          autocomplete="off"
          spellcheck={false}
          placeholder="fastlane/metadata/com.example.app/ios"
          error={shown('appStoreRoot') ?? shown('roots')}
          hint="The folder that holds the locale folders (en-US, de-DE, ...), relative to the repository. Leave empty if this target has no App Store listing."
        />
        <TextField
          id="{uid}-play"
          label="Google Play folder"
          bind:value={form.googlePlayRoot}
          autocomplete="off"
          spellcheck={false}
          placeholder="fastlane/metadata/com.example.app/android"
          error={shown('googlePlayRoot')}
          hint="The same for Google Play. Leave empty if this target has none."
        />
        <div class="row end">
          <Button disabled={saving} onclick={() => (editing = null)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>{editing === 'new' ? 'Save target' : 'Save changes'}</Button>
        </div>
      </form>
    {/if}
  </div>

  {#snippet footer()}
    <Button disabled={saving || deleting} onclick={() => (open = false)}>Close</Button>
  {/snippet}
</Modal>

<style>
  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border, currentColor);
  }

  .item .hint {
    margin: var(--space-1) 0 0;
  }

  .actions {
    gap: var(--space-2);
    align-items: center;
  }

  .row.end {
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
