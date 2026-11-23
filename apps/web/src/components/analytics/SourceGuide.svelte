<!--
  SourceGuide: under one source of the Data sources panel, the REAL cause of what is missing and the steps that fix it, with real links
  (docs/ux-ia.md). It replaces a next step that was only words ("Grant the Play permission"). Four guides: the Play bucket is refused (the
  Play Console invitation, or another account's bucket), the financial reports are refused (View financial data, Global), the Sales and
  Trends key or vendor number (Apple), and the bucket id itself. Google: the address to invite is shown with a copy button. Apple: the
  vendor number is entered here and kept for the Apple team of the app's credential. "Test access" makes ONE cheap call for this source
  and answers with a sentence from a fixed list, so nothing waits for the next sync. People without `analytics.manage` read the steps
  and cannot test or save.
  Props: api, workspaceId, app ({ id, platform }), role, source, kind (the guide, or null for "Test access" alone), status (of the app), onchanged.
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { t } from '../../lib/i18n/t.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, storedErrorText } from '../../lib/analytics/analytics.ts';
  import { type GuideKind, guideLinks, isTestable, probablyOtherAccount } from '../../lib/analytics/guide.ts';
  import { describeError } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import PlayBucketField from './PlayBucketField.svelte';
  import { normalizeVendorNumber } from '@kiln/core';

  let {
    api,
    workspaceId,
    app,
    role,
    source,
    kind,
    status,
    onchanged,
  }: { api: Api; workspaceId: string; app: { id: string; platform: string }; role: Role; source: string; kind: GuideKind | null; status: AnalyticsStatus; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const links = $derived(guideLinks(status.google));
  const email = $derived(status.google?.serviceAccountEmail ?? null);
  const other = $derived(kind === 'play_bucket' && probablyOtherAccount(status.google));

  let testing = $state(false);
  let outcome = $state<{ ok: boolean; text: string; email?: string } | null>(null);
  async function test() {
    if (testing) return;
    testing = true;
    outcome = null;
    try {
      const { result } = await api.testAnalyticsAccess(workspaceId, app.id, source);
      outcome = {
        ok: result.ok,
        text: result.code === 'ok' ? t('analytics:guide.testOk') : result.code === 'no_report_yet' ? t('analytics:guide.testNoReport') : storedErrorText(result.code),
        ...(result.serviceAccountEmail ? { email: result.serviceAccountEmail } : {}),
      };
    } catch (e) {
      outcome = { ok: false, text: describeError(e) };
    } finally {
      testing = false;
    }
  }

  let vendor = $state('');
  let savingVendor = $state(false);
  const vendorTyped = $derived(vendor.trim());
  const vendorValid = $derived(normalizeVendorNumber(vendorTyped) !== undefined);
  async function saveVendor() {
    if (!vendorValid || savingVendor) return;
    savingVendor = true;
    try {
      await api.setAppleVendorNumber(workspaceId, app.id, vendorTyped);
      toast.success(t('analytics:guide.vendor.saved'));
      vendor = '';
      onchanged();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      savingVendor = false;
    }
  }
</script>

{#snippet ext(href: string, label: string)}
  <a href={href} target="_blank" rel="noopener noreferrer">{label}<span class="visually-hidden"> {t('analytics:guide.opensNew')}</span></a>
{/snippet}

{#snippet address()}
  <div class="address">
    <span class="muted">{t('analytics:guide.account')}</span>
    {#if email}
      <code>{email}</code>
      <CopyButton value={email} />
    {:else}
      <span>{t('analytics:guide.accountUnknown')}</span>
    {/if}
  </div>
{/snippet}

<section class="guide" aria-label={t('analytics:guide.heading')}>
  {#if kind !== null}<strong>{t('analytics:guide.heading')}</strong>{/if}
  {#if kind === null}
    <!-- only "Test access" below -->
  {:else if kind === 'play_bucket'}
    <p>{t('analytics:guide.bucket.cause')}</p>
    {#if other}<Alert tone="warn">{t('analytics:guide.otherAccount')}</Alert>{/if}
    <ol>
      <li>{t('analytics:guide.bucket.step1')} {@render ext(links.usersAndPermissions, t('analytics:guide.link.usersAndPermissions'))}{@render address()}</li>
      <li>{t('analytics:guide.bucket.step2')}</li>
      <li>{t('analytics:guide.bucket.step3')} {#if links.bucket}{@render ext(links.bucket, t('analytics:guide.link.bucket'))}{/if}</li>
      <li>{t('analytics:guide.bucket.step4')}</li>
    </ol>
    {#if other && canManage}<PlayBucketField {api} {workspaceId} {role} {app} {onchanged} heading={false} />{/if}
  {:else if kind === 'play_finance'}
    <p>{t('analytics:guide.finance.cause')}</p>
    <ol>
      <li>{t('analytics:guide.finance.step1')} {@render ext(links.usersAndPermissions, t('analytics:guide.link.usersAndPermissions'))}{@render address()}</li>
      <li>{t('analytics:guide.finance.step2')}</li>
      <li>{t('analytics:guide.finance.step3')}</li>
    </ol>
  {:else if kind === 'play_bucket_id'}
    <p>{t('analytics:guide.bucketId.cause')} {@render ext('https://play.google.com/console', t('analytics:guide.link.playConsole'))}</p>
    {#if canManage}<PlayBucketField {api} {workspaceId} {role} {app} {onchanged} heading={false} />{/if}
  {:else}
    <p>{kind === 'apple_role' ? t('analytics:guide.role.cause') : status.sources.find((s) => s.source === source)?.lastError?.code === 'vendor_number_invalid' ? t('analytics:guide.vendor.causeInvalid') : t('analytics:guide.vendor.causeMissing')}</p>
    <ol>
      {#if kind === 'apple_role'}
        <li>{t('analytics:guide.role.step1')} {@render ext(links.usersAndAccess, t('analytics:guide.link.usersAndAccess'))}</li>
        <li>{t('analytics:guide.role.step2')} {@render ext(links.vendor, t('analytics:guide.link.vendor'))}</li>
      {:else}
        <li>{t('analytics:guide.vendor.step1')} {@render ext(links.vendor, t('analytics:guide.link.vendor'))}</li>
        <li>{t('analytics:guide.vendor.step2')}</li>
      {/if}
    </ol>
    {#if canManage}
      <form class="vendor" onsubmit={(e) => { e.preventDefault(); void saveVendor(); }}>
        <label for="vendor-{app.id}-{source}">{t('analytics:guide.vendor.label')}</label>
        <input id="vendor-{app.id}-{source}" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder={status.apple?.vendorNumber ?? '85123456'} bind:value={vendor} aria-invalid={vendorTyped !== '' && !vendorValid ? 'true' : undefined} />
        <Button type="submit" variant="secondary" loading={savingVendor} disabled={!vendorValid || savingVendor}>{t('common:action.save')}</Button>
      </form>
      <p class="muted">{vendorTyped !== '' && !vendorValid ? t('analytics:guide.vendor.invalid') : status.apple?.vendorNumberSource === 'workspace' ? t('analytics:guide.vendor.usingWorkspace') : t('analytics:guide.vendor.hint')}</p>
    {/if}
  {/if}
  {#if canManage && isTestable(source)}
    <div class="test">
      <Button variant="secondary" icon="refresh" loading={testing} disabled={testing} onclick={() => void test()}>{testing ? t('analytics:guide.testing') : t('analytics:guide.testAccess')}</Button>
    </div>
    {#if outcome}<Alert tone={outcome.ok ? 'ok' : 'warn'}>{outcome.text}</Alert>{/if}
  {/if}
</section>

<style>
  .guide {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-subtle, transparent);
    border-left: 3px solid var(--line);
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .guide p,
  .guide ol {
    margin: 0;
  }

  .guide ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-left: var(--space-5);
  }

  .address {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-top: var(--space-1);
  }

  .vendor {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .test {
    margin-top: var(--space-1);
  }
</style>
