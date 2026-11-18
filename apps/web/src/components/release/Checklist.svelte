<!--
  Checklist: the planning checklist of one release: tick items (who and when are kept), mark an item
  as required, add, edit, reorder and remove items, and add the items of a template. These are our
  own planning data; nothing here touches a store. Without the right to write, it is a read-only list.
  Props: api, workspaceId, plan (PlanDetail), canWrite, onplan (called with every updated plan).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { doneBy, moveId, planErrorMessage } from '../../lib/release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChecklistTemplate, PlanDetail, PlanItem } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    plan,
    canWrite,
    onplan,
  }: { api: Api; workspaceId: string; plan: PlanDetail; canWrite: boolean; onplan: (plan: PlanDetail) => void } = $props();

  const uid = $props.id();

  let busy = $state(false);
  let problem = $state('');
  let announcement = $state('');
  let newText = $state('');
  let newRequired = $state(true);
  let editingId = $state<string | null>(null);
  let editText = $state('');
  let templates = $state<ChecklistTemplate[]>([]);
  let templateId = $state('');
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  // The picker needs the templates only when the person can add from one.
  $effect(() => {
    void workspaceId;
    if (!canWrite) return;
    let live = true;
    api
      .checklistTemplates(workspaceId)
      .then((r) => {
        if (!live) return;
        templates = r.templates;
        if (!templates.some((t) => t.id === untrack(() => templateId))) templateId = templates[0]?.id ?? '';
      })
      .catch(() => {
        if (live) templates = [];
      });
    return () => {
      live = false;
    };
  });

  const items = $derived(plan.items);
  const required = $derived(plan.readiness.required);

  /** One request at a time, so two quick clicks cannot interleave their answers. */
  async function run<T extends { plan: PlanDetail }>(call: () => Promise<T>): Promise<T | null> {
    if (busy) return null;
    busy = true;
    problem = '';
    try {
      const result = await call();
      onplan(result.plan);
      return result;
    } catch (e) {
      problem = planErrorMessage(e);
      return null;
    } finally {
      busy = false;
    }
  }

  async function toggle(item: PlanItem, box: HTMLInputElement) {
    const done = box.checked;
    const result = await run(() => api.updateChecklistItem(workspaceId, plan.appId, plan.id, item.id, { done }));
    if (result) announcement = `${done ? 'Checked' : 'Unchecked'}: ${item.text}`;
    // The server did not take it: show what is stored.
    else box.checked = item.done;
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;
    const result = await run(() => api.addChecklistItem(workspaceId, plan.appId, plan.id, { text, required: newRequired }));
    if (result) {
      newText = '';
      announcement = `Added: ${text}`;
    }
  }

  async function saveEdit(item: PlanItem) {
    const text = editText.trim();
    if (!text) return;
    if (text === item.text) {
      editingId = null;
      return;
    }
    const result = await run(() => api.updateChecklistItem(workspaceId, plan.appId, plan.id, item.id, { text }));
    if (result) editingId = null;
  }

  async function setRequired(item: PlanItem, box: HTMLInputElement) {
    const result = await run(() => api.updateChecklistItem(workspaceId, plan.appId, plan.id, item.id, { required: box.checked }));
    if (!result) box.checked = item.required;
  }

  async function remove(item: PlanItem) {
    const result = await run(() => api.deleteChecklistItem(workspaceId, plan.appId, plan.id, item.id));
    if (result) announcement = `Removed: ${item.text}`;
  }

  async function move(item: PlanItem, index: number, delta: -1 | 1) {
    const order = moveId(items.map((i) => i.id), index, delta);
    const result = await run(() => api.reorderChecklist(workspaceId, plan.appId, plan.id, order));
    if (result) {
      announcement = `Moved ${item.text} ${delta === -1 ? 'up' : 'down'}`;
      // Keep the keyboard where it was: the same item's button at its new place.
      queueMicrotask(() => document.getElementById(`${uid}-${item.id}-${delta === -1 ? 'up' : 'down'}`)?.focus());
    }
  }

  async function applyTemplate() {
    if (!templateId) return;
    const picked = templates.find((t) => t.id === templateId);
    const result = await run(() => api.applyChecklistTemplate(workspaceId, plan.appId, plan.id, templateId));
    if (result && picked) {
      const text =
        result.added === 0
          ? `Everything in “${picked.name}” is already on the checklist.`
          : `Added ${result.added} ${result.added === 1 ? 'item' : 'items'} from “${picked.name}”${result.skipped > 0 ? `, ${result.skipped} already there` : ''}.`;
      toast.success(text);
      announcement = text;
    }
  }
</script>

<section class="card" aria-labelledby="{uid}-title">
  <div class="card-header">
    <div>
      <h2 id="{uid}-title">Checklist</h2>
      <p>
        {#if items.length === 0}
          No items yet.
        {:else}
          {required.done} of {required.total} required {required.total === 1 ? 'item' : 'items'} done{items.length > required.total ? `, ${items.length - required.total} optional` : ''}.
        {/if}
      </p>
    </div>
  </div>

  <p class="visually-hidden" role="status">{announcement}</p>
  {#if problem}<Alert tone="error">{problem}</Alert>{/if}

  {#if items.length === 0}
    <p class="empty muted">
      {canWrite ? 'Add the things to check before this version goes out, or start from a template below.' : 'Nobody has added checklist items yet.'}
    </p>
  {:else}
    <ul class="items">
      {#each items as item, index (item.id)}
        <li class="item" class:done={item.done}>
          <div class="main">
            {#if editingId === item.id}
              <form
                class="edit"
                onsubmit={(e) => {
                  e.preventDefault();
                  void saveEdit(item);
                }}
              >
                <TextField label="Item text" bind:value={editText} maxlength={300} disabled={busy} />
                <div class="row">
                  <Button type="submit" size="sm" variant="primary" loading={busy}>Save</Button>
                  <Button size="sm" disabled={busy} onclick={() => (editingId = null)}>Cancel</Button>
                </div>
              </form>
            {:else}
              <label class="check">
                <input type="checkbox" checked={item.done} disabled={!canWrite || busy} onchange={(e) => toggle(item, e.currentTarget)} />
                <span class="text">{item.text}</span>
              </label>
              <span class="tags">
                {#if item.required}<Badge tone="accent">Required</Badge>{:else}<Badge>Optional</Badge>{/if}
                {#if item.done && item.doneAt !== null}
                  <span class="muted small">
                    {doneBy(item)},
                    <time datetime={new Date(item.doneAt).toISOString()} title={fullTime(item.doneAt)}>{timeAgo(item.doneAt, now)}</time>
                  </span>
                {/if}
              </span>
            {/if}
          </div>
          {#if canWrite && editingId !== item.id}
            <div class="tools">
              <label class="check small">
                <input type="checkbox" checked={item.required} disabled={busy} onchange={(e) => setRequired(item, e.currentTarget)} />
                <span>Required</span>
              </label>
              <Button id="{uid}-{item.id}-up" size="sm" variant="ghost" iconOnly icon="chevron-up" label="Move “{item.text}” up" disabled={busy || index === 0} onclick={() => move(item, index, -1)} />
              <Button id="{uid}-{item.id}-down" size="sm" variant="ghost" iconOnly icon="chevron-down" label="Move “{item.text}” down" disabled={busy || index === items.length - 1} onclick={() => move(item, index, 1)} />
              <Button size="sm" variant="ghost" iconOnly icon="edit" label="Edit “{item.text}”" disabled={busy} onclick={() => { editingId = item.id; editText = item.text; }} />
              <Button size="sm" variant="ghost" iconOnly icon="trash" label="Remove “{item.text}”" disabled={busy} onclick={() => remove(item)} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canWrite}
    <form class="add" onsubmit={add}>
      <TextField label="Add an item" bind:value={newText} maxlength={300} placeholder="For example: Screenshots uploaded for every device size" disabled={busy} />
      <label class="check"><input type="checkbox" bind:checked={newRequired} /> <span>Required</span></label>
      <Button type="submit" icon="plus" loading={busy} disabled={newText.trim() === ''}>Add item</Button>
    </form>

    <div class="template">
      <div class="field">
        <label for="{uid}-template">Add the items of a template</label>
        <select id="{uid}-template" bind:value={templateId} disabled={busy || templates.length === 0}>
          {#each templates as template (template.id)}
            <option value={template.id}>{template.name}{template.builtin ? ' (built in)' : ''} · {template.items.length} items</option>
          {/each}
        </select>
        <p class="hint">Items already on the checklist are skipped. Existing items and ticks are not changed.</p>
      </div>
      <Button disabled={busy || !templateId} onclick={applyTemplate}>Add items</Button>
    </div>
  {/if}
</section>

<style>
  .empty {
    margin: 0 0 var(--space-4);
  }

  .items {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0 0 var(--space-4);
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
  }

  .item + .item {
    border-top: 1px solid var(--line);
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    flex: 1 1 280px;
  }

  .text {
    overflow-wrap: anywhere;
  }

  .item.done .text {
    color: var(--muted);
    text-decoration: line-through;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding-left: var(--space-6);
  }

  .small {
    font-size: var(--text-sm);
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: center;
  }

  .edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .add {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: var(--space-3);
    align-items: end;
    margin-bottom: var(--space-4);
  }

  .template {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .template .field {
    flex: 1 1 280px;
    margin: 0;
  }

  @media (max-width: 640px) {
    .add {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }
  }
</style>
