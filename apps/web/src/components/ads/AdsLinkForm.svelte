<!--
  AdsLinkForm: links one App Store record to an Apple Ads ad account, or shows and removes the link (docs/adr/0058-apple-ads.md). READ ONLY:
  the credential is an Apple Ads API user key and Kiln only reads reports with it. Steps: choose the credential, load the ad accounts it can
  read (one request to Apple, only when asked), choose one, confirm the Apple id of the app, Save. Nothing is changed in Apple Ads.
  Props: api, workspaceId, role, app (id, platform), link (null when not linked), credentials (null when the person may not read them),
  onchanged (called with the new link, or null after removing it).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AdsAccount, type AdsLinkView, adsCredentials, adsErrorText, adsLinks, validAdamId } from '../../lib/ads/ads.ts';
  import { formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import T from '../ui/T.svelte';
  import '../readable-card.css';

  let {
    api,
    workspaceId,
    role,
    app,
    link,
    credentials,
    now,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: string };
    link: AdsLinkView | null;
    credentials: CredentialSummary[] | null;
    now: number;
    onchanged: (link: AdsLinkView | null) => void;
  } = $props();

  const uid = $props.id();
  const canWrite = $derived(can(role, 'apps.write'));
  const choices = $derived(adsCredentials(credentials));

  let credentialId = $state('');
  let accountId = $state('');
  let adamId = $state('');
  let accounts = $state<AdsAccount[] | null>(null);
  let loadingAccounts = $state(false);
  let saving = $state(false);
  let removing = $state(false);
  let problem = $state('');

  const startKey = $derived(`${app.id}|${link?.updatedAt ?? '-'}`);
  $effect(() => {
    void startKey;
    untrack(() => {
      credentialId = link?.credentialId ?? '';
      accountId = link?.adAccountId ?? '';
      adamId = link?.adamId ?? '';
      accounts = null;
      problem = '';
    });
  });
  // Exactly one Apple Ads credential: choose it for the person.
  $effect(() => {
    if (credentialId === '' && choices.length === 1 && choices[0]) credentialId = choices[0].id;
  });

  const typedAdam = $derived(adamId.trim());
  const adamProblem = $derived(typedAdam !== '' && !validAdamId(typedAdam));
  const dirty = $derived(link === null || credentialId !== link.credentialId || accountId !== link.adAccountId || (typedAdam !== '' && typedAdam !== link.adamId) || !link.credentialAvailable);
  const canSave = $derived(canWrite && credentialId !== '' && accountId !== '' && !adamProblem && dirty && !saving);

  async function loadAccounts() {
    if (!canWrite || credentialId === '' || loadingAccounts) return;
    loadingAccounts = true;
    problem = '';
    try {
      const out = await api.adsAccounts(workspaceId, app.id, credentialId);
      accounts = out.accounts;
      if (accountId === '' && out.accounts.length === 1 && out.accounts[0]) accountId = out.accounts[0].id;
      if (out.accounts.length === 0) problem = t('ads:link.noAccounts');
    } catch (e) {
      accounts = null;
      problem = adsErrorText(e);
    } finally {
      loadingAccounts = false;
    }
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    problem = '';
    try {
      const out = await api.setAdsLink(workspaceId, app.id, { credentialId, adAccountId: accountId, ...(typedAdam === '' ? {} : { adamId: typedAdam }) });
      onchanged(out.link);
      toast.success(t('ads:link.linked', { account: out.link.adAccountName }));
    } catch (e) {
      problem = adsErrorText(e);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!canWrite || removing) return;
    removing = true;
    problem = '';
    try {
      await api.removeAdsLink(workspaceId, app.id);
      onchanged(null);
      toast.success(t('ads:link.removed'));
    } catch (e) {
      problem = adsErrorText(e);
    } finally {
      removing = false;
    }
  }
</script>

<div class="stack readable-card" data-testid="ads-link">
  {#if link}
    <dl class="facts">
      <div>
        <dt>{t('ads:link.account')}</dt>
        <dd>{link.adAccountName} <span class="muted">({link.adAccountId})</span></dd>
      </div>
      <div>
        <dt>{t('ads:link.currency')}</dt>
        <dd>{link.currency ?? t('ads:none')}{#if link.timezone} <span class="muted">· {link.timezone}</span>{/if}</dd>
      </div>
      <div>
        <dt>{t('ads:link.adamId')}</dt>
        <dd><code>{link.adamId}</code></dd>
      </div>
      <div>
        <dt>{t('ads:link.credential')}</dt>
        <dd>{link.credentialLabel ?? t('ads:link.credentialDeleted')}</dd>
      </div>
    </dl>
    <p class="row">
      <Badge tone={link.credentialAvailable ? 'ok' : 'warn'} icon={link.credentialAvailable ? 'check' : 'alert'}>{link.credentialAvailable ? t('ads:link.badgeLinked') : t('ads:link.badgeNeedsCredential')}</Badge>
      <span class="muted">{t('ads:link.checked', { when: formatRelativeTime(link.verifiedAt, { now }) })}</span>
    </p>
  {:else}
    <p class="muted">{t('ads:link.notLinked')}</p>
  {/if}

  {#if canWrite}
    {#if choices.length === 0}
      <Alert tone="info"><T key="ads:link.credentialsHint" tags={{ link: credentialsLink }} /></Alert>
    {:else}
      <div class="field">
        <label for="{uid}-credential">{t('ads:link.credential')}</label>
        <select id="{uid}-credential" bind:value={credentialId} disabled={saving} onchange={() => { accounts = null; accountId = ''; }}>
          <option value="">{t('ads:link.chooseCredential')}</option>
          {#each choices as c (c.id)}
            <option value={c.id}>{c.label}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="{uid}-account">{t('ads:link.account')}</label>
        <div class="row">
          <select id="{uid}-account" bind:value={accountId} disabled={saving || (accounts === null && link === null)}>
            {#if accounts === null}
              <option value={accountId}>{link && accountId === link.adAccountId ? link.adAccountName : t('ads:link.loadFirst')}</option>
            {:else}
              <option value="">{t('ads:link.chooseAccount')}</option>
              {#each accounts as a (a.id)}
                <option value={a.id}>{a.name} ({a.id})</option>
              {/each}
            {/if}
          </select>
          <Button size="sm" variant="secondary" icon="refresh" loading={loadingAccounts} disabled={credentialId === '' || loadingAccounts || saving} onclick={() => void loadAccounts()}>{t('ads:link.loadAccounts')}</Button>
        </div>
        <p class="hint">{t('ads:link.accountHint')}</p>
      </div>
      <div class="field">
        <label for="{uid}-adam">{t('ads:link.adamId')}</label>
        <input id="{uid}-adam" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder={t('ads:link.adamPlaceholder')} bind:value={adamId} disabled={saving} aria-invalid={adamProblem ? 'true' : undefined} />
        <p class="hint">{adamProblem ? t('ads:link.adamInvalid') : t('ads:link.adamHint')}</p>
      </div>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={saving} disabled={!canSave} onclick={() => void save()}>{link ? t('ads:link.saveChanges') : t('ads:link.linkAccount')}</Button>
        {#if link}
          <Button size="sm" variant="ghost" icon="trash" loading={removing} disabled={removing || saving} onclick={() => void remove()}>{t('ads:link.remove')}</Button>
        {/if}
      </div>
      <p class="hint">{t('ads:link.readOnly')}</p>
    {/if}
  {:else if link === null}
    <p class="muted">{t('ads:link.askAdmin')}</p>
  {/if}
</div>

{#snippet credentialsLink(text: string)}<a href={adsLinks.credentials}>{text}</a>{/snippet}

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }

  .facts dt {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
