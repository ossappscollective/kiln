<!--
  PlayBucketField: the Google Play reports bucket of ONE Android app (App settings, and the empty state of Insights). Installs and
  ratings come from monthly CSV files in the one private Cloud Storage bucket of the Play developer account that owns the app, and a
  workspace can hold apps of several accounts, so the bucket is a setting of the app. It inherits the workspace default (Settings,
  Analytics) until the app has its own: "Use the workspace default" shows the inherited value and clears the app's own.
  "Test the bucket" lists this app's report files once and answers with a sentence from a fixed vocabulary (never Google's text).
  Reading is open to everyone; changing and testing need `analytics.manage` (owners and admins).
  Props: api, workspaceId, role, app (id, platform), onchanged? (called after a save, so the screen reads its status again),
  heading? (draw the small label, default true).
  Readable pass (docs/design/readability.md): 15px text, label + control + ONE hint, one primary (Save), and the test is one word with a quiet
  action; the sentence of the answer stays under it.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api } from '../../lib/api.ts';
  import { type PlayBucketTestResult, type PlayBucketView, analyticsErrorText, bucketSourceText } from '../../lib/analytics/analytics.ts';
  import { bucketFormState } from '../../lib/analytics/bucket-form.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import { bucketTestWord } from '../../lib/readable-forms.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import '../readable-card.css';

  let {
    api,
    workspaceId,
    role,
    app,
    onchanged,
    heading = true,
  }: { api: Api; workspaceId: string; role: Role; app: { id: string; platform: string }; onchanged?: (() => void) | undefined; heading?: boolean | undefined } = $props();

  const uid = $props.id();
  const canManage = $derived(can(role, 'analytics.manage'));

  let view = $state<PlayBucketView | null>(null);
  let loadError = $state('');
  let useDefault = $state(true);
  let text = $state('');
  let problem = $state('');
  let saving = $state(false);
  let testing = $state(false);
  let result = $state<PlayBucketTestResult | null>(null);

  let touched = $state(false);

  const inherited = $derived(view?.inherited.bucketId ?? null);
  // One pure function decides what is valid, what changed and what the buttons may do (lib/analytics/bucket-form.ts).
  const form = $derived(bucketFormState({ saved: view === null ? undefined : view.app, useDefault, text, inherited, saving, testing, canManage }));
  const problemText = $derived(form.problem === 'invalid' ? t('analytics:bucketField.invalid') : form.problem === 'empty' && touched ? t('analytics:bucketField.empty') : '');

  function choose(next: boolean) {
    useDefault = next;
    result = null;
    problem = '';
    touched = false;
    // Going back to a custom bucket brings the saved one back instead of an empty field.
    if (!next && text.trim() === '' && view?.app) text = view.app;
  }

  function fill(next: PlayBucketView) {
    view = next;
    useDefault = next.app === null;
    text = next.app ?? '';
    touched = false;
  }

  $effect(() => {
    const id = app.id;
    const space = workspaceId;
    untrack(() => {
      view = null;
      result = null;
      problem = '';
      loadError = '';
      api
        .playBucket(space, id)
        .then((r) => {
          if (id === app.id) fill(r.playBucket);
        })
        .catch((e) => {
          loadError = analyticsErrorText(e);
        });
    });
  });

  async function save() {
    if (saving || !canManage) return;
    touched = true;
    if (form.saveValue === undefined) return;
    saving = true;
    problem = '';
    let saved = false;
    try {
      const out = await api.setPlayBucket(workspaceId, app.id, { bucket: form.saveValue, scope: 'app' });
      fill(out.playBucket);
      result = null;
      saved = true;
      toast.success(useDefault ? t('analytics:bucketField.toastDefault') : t('analytics:bucketField.toastSaved'));
    } catch (e) {
      problem = analyticsErrorText(e);
    } finally {
      saving = false;
    }
    if (saved) {
      // The panel behind reads its status again, and the bucket that was just saved is tested so the answer is on screen.
      onchanged?.();
      if (form.canTest) void test();
    }
  }

  async function test() {
    if (testing || !canManage) return;
    touched = true;
    if (!form.canTest) return;
    testing = true;
    problem = '';
    result = null;
    try {
      // What is typed is tested before it is saved; the inherited value is tested when "use the default" is on.
      const out = await api.testPlayBucket(workspaceId, app.id, form.testValue);
      result = out.result;
    } catch (e) {
      problem = analyticsErrorText(e);
    } finally {
      testing = false;
    }
  }

  const tone = (r: PlayBucketTestResult) => (r.code === 'ok' ? 'ok' : r.ok ? 'info' : 'warn');
  const testState = $derived(bucketTestWord(result, testing));
</script>

<div class="stack readable-card">
  {#if heading}<strong id="{uid}-h">{t('analytics:bucketField.heading')}</strong>{/if}
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
  {:else if view === null}
    <p class="muted" role="status">{t('analytics:bucketField.loading')}</p>
  {:else}
    <p class="muted">{t('analytics:bucketField.intro', { source: bucketSourceText(view) })}</p>
    {#if canManage}
      <label class="check">
        <input type="checkbox" checked={useDefault} onchange={(e) => choose(e.currentTarget.checked)} />
        {inherited ? t('analytics:bucketField.useDefault', { bucket: inherited }) : t('analytics:bucketField.useDefaultNone')}
      </label>
      <div class="field">
        <label for="{uid}-bucket">{t('analytics:bucketField.label')}</label>
        <input
          id="{uid}-bucket"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="gs://pubsite_prod_rev_…"
          value={useDefault ? (inherited ?? '') : text}
          oninput={(e) => {
            text = e.currentTarget.value;
            result = null;
          }}
          onblur={() => (touched = true)}
          disabled={useDefault}
          aria-invalid={problemText || problem ? 'true' : undefined}
          aria-describedby="{uid}-hint"
        />
        <p class="hint" id="{uid}-hint">{t('analytics:bucketField.hint')}</p>
        {#if problemText}
          <p class="invalid" role="alert">{problemText}</p>
        {:else if !useDefault && form.normalized !== undefined && form.normalized !== form.typed}
          <p class="hint" role="status">{t('analytics:bucketField.normalized', { bucket: form.normalized })}</p>
        {/if}
      </div>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {#if result}<Alert tone={tone(result)}>{result.message}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={saving} disabled={!form.canSave} onclick={() => void save()}>{t('common:action.save')}</Button>
        <span class="connection">
          <Badge tone={testState.tone}>{testState.label}</Badge>
          <Button size="sm" variant="ghost" loading={testing} disabled={!form.canTest} onclick={() => void test()}>{t('analytics:bucketField.test')}</Button>
        </span>
      </div>
    {:else}
      <p>
        {view.bucketId ? t('analytics:bucketField.readOnly', { bucket: view.bucketId }) : t('analytics:bucketField.readOnlyNone')}
      </p>
    {/if}
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .invalid {
    margin: 0;
    color: var(--bad-ink);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
