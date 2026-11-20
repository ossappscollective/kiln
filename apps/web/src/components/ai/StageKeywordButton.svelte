<!--
  StageKeywordButton: under an AI keyword idea that names a listing field, "Stage in title" / "Stage in keyword field" / ... It opens the
  field editor with the keyword added to the stored text of that field and locale: the text before and after, the character budget, and
  the editor's own "Stage" button, which is the only thing that writes (a staged change in our own database; nothing reaches a store).
  For the App Store name and subtitle, which a draft push cannot write, the button says "Draft in title" and the editor is a place to
  work the text out and copy it.
  Props: api, workspaceId, role, appId, platform, store ('app_store' | 'google_play'), locale, term (the keyword), field (the listing field
  the idea names).
-->
<script lang="ts">
  import type { Platform, Role } from '@mrm/core';
  import { canStagePlacement, placementWord, stageInLabel } from '../../lib/ai-placement.ts';
  import type { Api } from '../../lib/api.ts';
  import { storeTextOf } from '../../lib/keyword-use.ts';
  import { addTermToText } from '../../lib/listing-edit.ts';
  import { fieldInfo } from '../../lib/listing-edit.ts';
  import Button from '../ui/Button.svelte';
  import FieldEditor from '../listing/FieldEditor.svelte';

  let {
    api,
    workspaceId,
    role,
    appId,
    platform,
    store,
    locale,
    term,
    field,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    appId: string;
    platform: Platform;
    store: 'app_store' | 'google_play';
    locale: string;
    term: string;
    field: string;
  } = $props();

  let open = $state(false);
  let busy = $state(false);
  let current = $state<string | null | undefined>(undefined);
  let seed = $state<{ text: string; note: string } | null>(null);
  let problem = $state('');

  const stageable = $derived(canStagePlacement(store, field));
  const info = $derived(fieldInfo(platform, field));

  async function start() {
    if (busy || info === null) return;
    busy = true;
    problem = '';
    try {
      const listing = await api.asoListingKeywords(workspaceId, appId);
      const found = listing.locales.find((l) => l.locale === locale);
      const text = found ? storeTextOf(found.fields, field) : '';
      current = found ? text : null;
      const added = addTermToText(info, text, term, locale);
      seed = { text: added.text, note: added.note };
      open = true;
    } catch {
      problem = 'Could not read the stored listing text. Read the listing from the store first.';
    } finally {
      busy = false;
    }
  }
</script>

{#if info !== null}
  <div class="stage">
    <Button size="sm" icon="layers" loading={busy} onclick={() => void start()}>
      {stageable ? stageInLabel(field) : `Draft in ${placementWord(field)}`}
    </Button>
    {#if !stageable}
      <span class="muted small">A draft push cannot write the {placementWord(field)} on this store, so this stays a draft you copy.</span>
    {/if}
    {#if problem}<span class="small bad">{problem}</span>{/if}
  </div>
  {#if open}
    <FieldEditor bind:open {api} {workspaceId} {role} {appId} {platform} {locale} {field} {current} {seed} />
  {/if}
{/if}

<style>
  .stage {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .small {
    font-size: var(--text-xs);
  }

  .bad {
    color: var(--bad-ink);
  }
</style>
