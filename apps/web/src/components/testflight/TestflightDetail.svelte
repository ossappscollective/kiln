<!--
  TestflightDetail: one TestFlight feedback or crash (docs/api/testflight-feedback.md): the comment, the tester and device facts, the screenshots
  (sizes, and Apple's short-lived links read on request: the page's content security policy allows images from this site only, so they are links,
  never drawn), the crash log (monospace, collapsible, copyable, with a note that never claims the log is symbolicated), and the triage (status,
  assignee, internal note; Kiln's own data, never sent to Apple). The tester's email is shown to administrators only (the server decides).
  Props: api, workspaceId, role, appId, id, members (for the assignee), consoleUrl (App Store Connect, or null), onclose, ontriaged (called with
  the saved item).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { formatDateTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import {
    buildLabel,
    deviceFacts,
    linkExpired,
    MAX_NOTE_LENGTH,
    type ScreenshotLink,
    statusBadge,
    statusLabel,
    symbolicationNote,
    TRIAGE_STATUSES,
    type TestflightItem,
    testerLabel,
    triageDiff,
    type TriageStatus,
  } from '../../lib/testflight.ts';
  import type { Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let {
    api,
    workspaceId,
    role,
    appId,
    id,
    members,
    consoleUrl,
    onclose,
    ontriaged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    appId: string;
    id: string;
    members: Member[];
    consoleUrl: string | null;
    onclose: () => void;
    ontriaged: (item: TestflightItem) => void;
  } = $props();

  const uid = $props.id();
  const mayTriage = $derived(can(role, 'reviews.triage'));

  let item = $state<TestflightItem | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let draft = $state<{ status: TriageStatus; assigneeUserId: string; internalNote: string }>({ status: 'new', assigneeUserId: '', internalNote: '' });
  let saving = $state(false);
  let saveProblem = $state('');
  let showLog = $state(false);
  /** The screenshots the tester attached to this feedback (not the store's graphics). */
  const attachments = $derived(item.screenshots);
  let links = $state<ScreenshotLink[] | null>(null);
  let linksLoading = $state(false);
  let linksProblem = $state('');
  const clock = useNow({ everyMs: 30_000 });
  const now = $derived(clock.value);

  function reset(from: TestflightItem) {
    draft = { status: from.status, assigneeUserId: from.assigneeUserId ?? '', internalNote: from.internalNote ?? '' };
  }

  async function load() {
    loading = true;
    problem = '';
    try {
      const read = await api.appTestflightItem(workspaceId, appId, id);
      item = read.item;
      reset(read.item);
      clock.touch();
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('testflight:detail.loadError');
    } finally {
      loading = false;
    }
  }
  void load();

  const changes = $derived(
    item ? triageDiff(item, { status: draft.status, assigneeUserId: draft.assigneeUserId === '' ? null : draft.assigneeUserId, internalNote: draft.internalNote }) : {},
  );
  const dirty = $derived(Object.keys(changes).length > 0);
  const assignee = $derived(
    item?.assigneeUserId ? (members.find((m) => m.userId === item?.assigneeUserId)?.displayName ?? t('testflight:detail.formerMember')) : null,
  );

  async function save() {
    if (!item || saving || !dirty) return;
    saving = true;
    saveProblem = '';
    try {
      const done = await api.triageTestflightItem(workspaceId, appId, id, changes);
      item = { ...done.item, crashLog: item.crashLog ?? null };
      reset(done.item);
      toast.success(t('testflight:detail.saved'));
      ontriaged(done.item);
    } catch (e) {
      saveProblem = e instanceof ApiError ? e.message : t('testflight:detail.saveFailed');
    } finally {
      saving = false;
    }
  }

  async function getLinks() {
    if (linksLoading) return;
    linksLoading = true;
    linksProblem = '';
    try {
      links = (await api.appTestflightScreenshots(workspaceId, appId, id)).screenshots;
      clock.touch();
    } catch (e) {
      linksProblem = e instanceof ApiError ? e.message : t('testflight:detail.screenshotsFailed');
    } finally {
      linksLoading = false;
    }
  }

  const expiry = $derived(links?.map((l) => l.expiresAt).filter((e): e is number => e !== null).sort((a, b) => a - b)[0] ?? null);
</script>

<aside class="card detail" aria-labelledby="{uid}-title">
  <div class="row between">
    <h3 class="title" id="{uid}-title">{t('testflight:detail.title')}</h3>
    <Button size="sm" variant="ghost" icon="x" onclick={onclose}>{t('testflight:detail.close')}</Button>
  </div>

  {#if loading}
    <div role="status" aria-label={t('testflight:detail.loading')} class="stack"><Skeleton width="100%" height="1.5rem" /><Skeleton width="100%" height="6rem" /></div>
  {:else if problem !== '' || !item}
    <Alert tone="error">{problem}</Alert>
  {:else}
    {@const badge = statusBadge(item.status)}
    <div class="row head">
      <Badge tone={badge.tone} dot>{badge.label}</Badge>
      <span class="text-sm">{buildLabel(item.buildNumber, item.version)}</span>
      <span class="muted text-sm">{formatDateTime(item.createdAt)}</span>
    </div>

    <section class="stack" aria-label={t('testflight:detail.comment')}>
      <h4 class="heading">{t('testflight:detail.comment')}</h4>
      {#if item.comment !== ''}<p class="comment">{item.comment}</p>{:else}<p class="muted">{t('testflight:list.noComment')}</p>{/if}
    </section>

    <section class="stack" aria-label={t('testflight:detail.deviceHeading')}>
      <h4 class="heading">{t('testflight:detail.deviceHeading')}</h4>
      <dl class="facts">
        <dt>{t('testflight:detail.tester')}</dt>
        <dd>{testerLabel(item)}{#if item.testerEmail === null && item.tester !== null}<span class="muted text-sm"> · {t('testflight:detail.emailHidden')}</span>{/if}</dd>
        {#each deviceFacts(item) as fact (fact.label)}
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        {/each}
      </dl>
    </section>

    {#if item.kind === 'feedback'}
      <section class="stack" aria-label={t('testflight:detail.screenshotsHeading')}>
        <h4 class="heading">{t('testflight:detail.screenshotsHeading')}</h4>
        {#if attachments.length === 0}
          <p class="muted text-sm">{t('testflight:detail.screenshotsNone')}</p>
        {:else}
          <p class="muted text-sm">{t('testflight:detail.screenshotsCount', { count: attachments.length })}</p>
          {#if links === null}
            <div class="row">
              <Button size="sm" icon="external-link" loading={linksLoading} onclick={() => void getLinks()}>{t('testflight:detail.screenshotsLoad')}</Button>
              {#if consoleUrl}<a class="text-sm" href={consoleUrl} target="_blank" rel="noopener noreferrer">{t('testflight:tab.openConsole')}</a>{/if}
            </div>
          {:else if links.length === 0}
            <p class="muted text-sm">{t('testflight:detail.screenshotsNoLinks')}</p>
          {:else}
            <ul class="plain">
              {#each links as link, n (link.url)}
                <li class="row">
                  <!-- Apple's link, opened in a new tab: a link is not an image load, so the content security policy does not apply. -->
                  <a href={link.url} target="_blank" rel="noopener noreferrer" aria-disabled={linkExpired(link, now)}>{t('testflight:detail.screenshotsOpen', { number: n + 1 })}</a>
                  {#if link.width !== null && link.height !== null}<span class="muted text-sm">{t('testflight:detail.screenshotsSize', { width: link.width, height: link.height })}</span>{/if}
                </li>
              {/each}
            </ul>
            {#if expiry !== null}<p class="muted text-sm">{t('testflight:detail.screenshotsExpire', { when: timeAgo(expiry, now) })}</p>{/if}
            <div class="row"><Button size="sm" icon="refresh" loading={linksLoading} onclick={() => void getLinks()}>{t('testflight:detail.screenshotsLoad')}</Button></div>
          {/if}
          {#if linksProblem !== ''}<Alert tone="error">{linksProblem}</Alert>{/if}
        {/if}
      </section>
    {:else}
      <section class="stack" aria-label={t('testflight:crash.heading')}>
        <h4 class="heading">{t('testflight:crash.heading')}</h4>
        {#if item.signature}
          <div>
            <div class="muted text-sm">{t('testflight:crash.signature')}</div>
            <div class="mono sig">{item.signature}</div>
            <div class="muted text-sm">{t('testflight:crash.signatureHint')}</div>
          </div>
        {/if}
        {#if item.crashLogState === 'stored' && item.crashLog}
          <p class="muted text-sm">{symbolicationNote(item)}</p>
          <div class="row">
            <Button size="sm" aria-expanded={showLog} aria-controls="{uid}-log" onclick={() => (showLog = !showLog)}>{showLog ? t('testflight:crash.hide') : t('testflight:crash.show')}</Button>
            <CopyButton value={item.crashLog} size="sm" label={t('testflight:crash.copy')} />
          </div>
          {#if showLog}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable region must be reachable with the keyboard. -->
            <pre id="{uid}-log" class="log" tabindex="0" aria-label={t('testflight:crash.heading')}>{item.crashLog}</pre>
            {#if item.crashLogTruncated}<p class="muted text-sm">{t('testflight:crash.truncated')}</p>{/if}
          {/if}
        {:else if item.crashLogState === 'missing'}
          <p class="muted text-sm">{t('testflight:crash.missing')}</p>
        {:else}
          <p class="muted text-sm">{t('testflight:crash.noLog')}</p>
        {/if}
        {#if consoleUrl}<a class="text-sm" href={consoleUrl} target="_blank" rel="noopener noreferrer">{t('testflight:tab.openConsole')}</a>{/if}
      </section>
    {/if}

    <section class="stack" aria-label={t('testflight:detail.triageHeading')}>
      <h4 class="heading">{t('testflight:detail.triageHeading')}</h4>
      {#if mayTriage}
        <form
          class="stack"
          onsubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="field">
            <label for="{uid}-status">{t('testflight:detail.status')}</label>
            <select id="{uid}-status" bind:value={draft.status} disabled={saving}>
              {#each TRIAGE_STATUSES as s (s)}<option value={s}>{statusLabel(s)}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-assignee">{t('testflight:detail.assignee')}</label>
            <select id="{uid}-assignee" bind:value={draft.assigneeUserId} disabled={saving}>
              <option value="">{t('testflight:detail.nobody')}</option>
              {#each members as member (member.userId)}<option value={member.userId}>{member.displayName}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-note">{t('testflight:detail.note')}</label>
            <textarea id="{uid}-note" rows="3" maxlength={MAX_NOTE_LENGTH} bind:value={draft.internalNote} disabled={saving} aria-describedby="{uid}-note-hint"></textarea>
            <p class="hint" id="{uid}-note-hint">{t('testflight:detail.noteHint')}</p>
          </div>
          {#if saveProblem !== ''}<Alert tone="error">{saveProblem}</Alert>{/if}
          <div class="row"><Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty}>{t('testflight:detail.save')}</Button></div>
        </form>
      {:else}
        <p class="text-sm">{statusLabel(item.status)}{#if assignee} · {t('testflight:detail.assignee')}: {assignee}{/if}</p>
        {#if item.internalNote}<p class="comment text-sm">{item.internalNote}</p>{/if}
      {/if}
      {#if item.statusChangedAt !== null}<p class="muted text-sm">{t('testflight:detail.changedBy', { ago: timeAgo(item.statusChangedAt, now) })}</p>{/if}
    </section>
  {/if}
</aside>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .title,
  .heading {
    margin: 0;
    font-size: var(--text-md);
  }

  .heading {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .between {
    justify-content: space-between;
    align-items: center;
  }

  .head {
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .comment {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt {
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .sig {
    overflow-wrap: anywhere;
  }

  .log {
    max-height: 24rem;
    overflow: auto;
    white-space: pre;
    font-size: var(--text-xs);
  }
</style>
