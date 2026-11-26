<!--
  CreateVersion: the way out of "no version in Prepare for Submission" on the build step. App Store and Mac App Store only
  (Google Play has no such thing: a version there is a release). A small inline form, "Create version [3.1.2]", prefilled
  with the next patch of the newest version this app has shown, and one clearly worded button. Creating a version is a
  REVERSIBLE draft write (App Store Connect lets you delete it in Prepare for Submission), so there is no typed phrase:
  a click previews (a store read), then creates once with the preview's hash, inside `confirmed(...)` so a workspace that
  covers the action with a step-up asks for the person's confirmation. Never retried by this app.
  Drawn for admin and up (`store.push_draft`); otherwise, and while the server's draft-write switch is off, the old sentence
  stays, and the switch case names KILN_STORE_DRAFT_WRITE_ENABLED. docs/api/store-version.md, docs/adr/0031-create-app-store-version.md.
  Props: api, workspaceId, role, app ({ id, platform }), onread (read the stepper's store state again after a create),
  prefill? (the version string the form starts with: "Create release 2.0.1 from TestFlight build 95", from the state model's next step).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { announcePublished } from '../../../lib/app-page.ts';
  import type { Api } from '../../../lib/api.ts';
  import { confirmed } from '../../../lib/step-up-prompt.svelte.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import {
    NO_VERSION_SENTENCE,
    VERSION_ENV,
    VERSION_NOTE,
    VERSION_ROLE_REASON,
    blockingText,
    classifyVersionFailure,
    suggestedVersion,
  } from '../../../lib/store-version.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { appStateStore } from '../../../lib/app-state/app-state-store.svelte.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import T from '../../ui/T.svelte';
  import type { AppSummary } from '../../../lib/types.ts';
  import Button from '../../ui/Button.svelte';
  import PublishingNote from '../../publish/PublishingNote.svelte';
  import TextField from '../../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    onread,
    prefill = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    onread: () => void;
    /** The version the form starts with ("Create release 2.0.1 from TestFlight build 95"); null: the next patch of the newest version. */
    prefill?: string | null;
  } = $props();

  const mayCreate = $derived(can(role, 'store.push_draft'));
  const config = $derived(stagedStore.config(workspaceId));
  const off = $derived(config !== null && !config.enabled);

  let versionText = $state('');
  let touched = false;
  let busy = $state(false);
  let problem = $state('');
  let announcement = $state('');

  $effect(() => {
    void stagedStore.loadConfig(api, workspaceId);
  });
  $effect(() => {
    // The next patch of the newest version the stored releases of this app show; the person can change it, and it is never
    // put over something they typed.
    const id = app.id;
    const platform = app.platform;
    api
      .app(workspaceId, id)
      .then((detail) => {
        if (!touched && id === app.id)
          versionText = prefill !== null && prefill !== '' ? prefill : suggestedVersion(detail.releases, platform);
      })
      .catch(() => undefined);
  });

  /** Whether the app state allows creating a version now (not while a publish of the app runs, nor while its last publish failed). */
  const verdict = $derived(appStateStore.verdict(workspaceId, role, app, 'create_version'));

  async function create() {
    const wanted = versionText.trim();
    if (wanted === '' || busy || !verdict.enabled) return;
    busy = true;
    problem = '';
    announcement = '';
    try {
      const looked = await api.previewStoreVersion(workspaceId, app.id, { versionString: wanted });
      const preview = looked.preview;
      if (!preview.checks.canCreate || preview.confirmHash === null) {
        problem = t('release-store:version.nothingCreated', { message: blockingText(preview.checks.blocking) });
        return;
      }
      const body = { versionString: wanted, confirmHash: preview.confirmHash };
      // The only call that writes to the store. Sent once per click, with the hash of the preview.
      const done = await confirmed((grant) => api.createStoreVersion(workspaceId, app.id, body, grant), body.confirmHash);
      const warnings = done.result.warnings.map((w) => w.message).join(' ');
      const text = [t('release-stepper:cv.created', { version: done.result.version.versionString }), warnings].filter((s) => s !== '').join(' ');
      announcement = text;
      toast.success(text);
      // The app reads its store again (the same announcement a publish makes) and the stepper looks for the version.
      announcePublished(app.id);
      onread();
    } catch (e) {
      const failure = classifyVersionFailure(e);
      if (failure.kind === 'disabled') stagedStore.markDisabled(workspaceId);
      problem = failure.message;
      announcement = failure.message;
    } finally {
      busy = false;
    }
  }
</script>

{#if !mayCreate}
  <p class="small">{t(NO_VERSION_SENTENCE)}</p>
  <p class="small muted">{t(VERSION_ROLE_REASON)}</p>
{:else if off}
  <p class="small">{t(NO_VERSION_SENTENCE)}</p>
  <p class="small muted"><T key="release-stepper:cv.off" params={{ env: `${VERSION_ENV}=true` }} /></p>
{:else}
  <p class="small">{t('release-stepper:cv.none')}</p>
  <form
    class="create"
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <TextField
      label={t('release-stepper:cv.version')}
      bind:value={versionText}
      oninput={() => (touched = true)}
      disabled={busy}
      autocomplete="off"
      spellcheck="false"
      inputmode="decimal"
      maxlength={40}
    />
    <Button type="submit" variant="primary" loading={busy} disabled={versionText.trim() === '' || !verdict.enabled} title={!verdict.enabled ? (verdict.reason ?? undefined) : undefined}>
      {t('release-stepper:cv.create', { version: versionText.trim() })}
    </Button>
  </form>
  <PublishingNote {verdict} appId={app.id} />
  <p class="small muted">{t(VERSION_NOTE)}</p>
  {#if problem !== ''}<p class="small bad" role="alert">{problem}</p>{/if}
  <p class="visually-hidden" role="status">{announcement}</p>
{/if}

<style>
  .create {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: flex-end;
    margin: var(--space-2) 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .muted {
    color: var(--muted);
  }

  .bad {
    color: var(--bad-ink);
  }
</style>
