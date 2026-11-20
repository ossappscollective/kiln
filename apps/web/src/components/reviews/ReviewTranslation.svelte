<!--
  ReviewTranslation: "Translate" for one review, with the result below it.
  Props: api, workspaceId, appId, review (id, title, body, language), and optionally stored (a translation
  already made elsewhere, for example by "Translate all visible" of the Reviews tab), onstore (called with a
  translation made here, so the owner can keep it) and showAll (false hides every translation body; the
  head stays, with "Show").
  Shown only when translation is turned on in the workspace settings, the person may translate
  (members and above), and the review is not already in the target language. The server reads the
  review's text from its own database: only the review id is sent. The translation is machine
  output derived from customer text: it is shown as plain text (never as markup), says which
  provider made it, and says that the text left this server.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type ReviewTranslation,
    isRetryable,
    needsTranslation,
    privacyNote,
    translationCaption,
    translationErrorMessage,
  } from '../../lib/reviews/translation.ts';
  import { type TranslationConfig, languageName, loadTranslationConfig } from '../../lib/settings.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    appId,
    review,
    stored = undefined,
    onstore = undefined,
    showAll = true,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    review: { id: string; title: string | null; body: string; language: string | null };
    stored?: ReviewTranslation | undefined;
    onstore?: ((t: ReviewTranslation) => void) | undefined;
    showAll?: boolean;
  } = $props();

  let config = $state<TranslationConfig | null>(null);
  let result = $state<ReviewTranslation | null>(null);
  let visible = $state(true);
  let loading = $state(false);
  let problem = $state('');
  let retry = $state(false);

  $effect(() => {
    void workspaceId;
    let live = true;
    config = null;
    void loadTranslationConfig(api, workspaceId).then((c) => {
      if (live) config = c;
    });
    return () => {
      live = false;
    };
  });

  // A different review, or its text changed after a sync: the old translation no longer applies.
  $effect(() => {
    void review.id;
    void review.body;
    void review.title;
    result = null;
    problem = '';
    visible = showAll;
  });

  // A translation made elsewhere (translate all) is shown here; the toggle of the list hides or shows them all.
  $effect(() => {
    if (stored) result = stored;
  });
  $effect(() => {
    visible = showAll;
  });

  const available = $derived(!!config && config.enabled && config.mode !== 'off' && needsTranslation(review, config.target));

  async function translate() {
    if (loading || !config) return;
    loading = true;
    problem = '';
    retry = false;
    try {
      const done = await api.translateReviews(workspaceId, appId, { reviewIds: [review.id] });
      const found = done.translations.find((t) => t.reviewId === review.id);
      if (found) {
        result = found;
        visible = true;
        onstore?.(found);
      } else {
        problem = 'This review is no longer stored here. Reload the list.';
      }
    } catch (e) {
      problem = translationErrorMessage(e);
      retry = isRetryable(e);
    } finally {
      loading = false;
    }
  }
</script>

{#if available && config}
  {#if !result}
    <div class="row">
      <Button size="sm" variant="ghost" icon="globe" {loading} onclick={translate}>
        {retry ? 'Try again' : `Translate to ${languageName(config.target)}`}
      </Button>
    </div>
  {:else if result.sameLanguage}
    <p class="hint">This review is already in {languageName(config.target)}.</p>
  {:else}
    <div class="translation">
      <p class="head">
        <strong>Translation</strong>
        <button type="button" class="link sm" aria-expanded={visible} onclick={() => (visible = !visible)}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </p>
      {#if visible}
        {#if result.title}<p class="title">{result.title}</p>{/if}
        {#if result.body}<p class="body">{result.body}</p>{/if}
        {#if result.truncated}<p class="hint">The review is long: only the first 5,000 characters were translated.</p>{/if}
        <p class="hint">{translationCaption(result, review.language)} {privacyNote(result.provider)}</p>
      {/if}
    </div>
  {/if}
  {#if problem}<Alert tone="error">{problem}</Alert>{/if}
{/if}

<style>
  .translation {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }

  .head {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  /* Machine output of customer text: plain, wrapped, line breaks kept. */
  .title,
  .body {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .title {
    font-weight: 600;
  }

  .hint {
    margin: 0;
  }
</style>
