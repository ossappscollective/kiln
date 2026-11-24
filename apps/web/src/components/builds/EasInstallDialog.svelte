<!--
  EasInstallDialog: installs one EAS build on a test device, the way Expo's own dialog does (ADR 0061). A QR code of the build's page at
  expo.dev (drawn here, no service, nothing leaves the page), the same address in a read-only field with Copy, "Open on Expo", help for the
  platform, and, where the server hands out the address of the build file, "Download build" (a plain link to Expo, never proxied) and
  "Open with Orbit" (a desktop-only link with Expo Orbit's own scheme).
  Props: build (the stored EAS build), title (what the row is called), now, onclose.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { qrMatrix } from '../../lib/qr.ts';
  import {
    INTERNAL_DISTRIBUTION_DOCS_URL,
    ORBIT_DOWNLOAD_URL,
    downloadOf,
    installPlan,
    isMobileUserAgent,
    orbitLink,
  } from '../../lib/eas/eas-install.ts';
  import type { EasBuildView } from '../../lib/eas/eas-status.ts';
  import { fullTime } from '../../lib/format.ts';
  import QrCode from '../QrCode.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import Tooltip from '../ui/Tooltip.svelte';

  let { build, title, now, onclose }: { build: EasBuildView; title: string; now: number; onclose: () => void } = $props();

  let open = $state(true);
  let orbitTried = $state(false);

  const plan = $derived(installPlan(build, now));
  const address = $derived(build.expoUrl ?? '');
  const codeFits = $derived(plan.qr && address !== '' && qrMatrix(address) !== null);
  const file = $derived(downloadOf(build, now));
  const orbit = $derived(isMobileUserAgent(navigator.userAgent) ? null : orbitLink(build, now));
  const lead = $derived(
    plan.simulator
      ? t('builds:install.leadSimulator')
      : !plan.qr
        ? t('builds:install.leadNoCode')
        : build.platform === 'android'
          ? t('builds:install.leadAndroid')
          : t('builds:install.leadIos'),
  );
</script>

<Modal bind:open title={t('builds:install.title')} description={title} size="md" {onclose}>
  <div class="stack">
    <p class="lead">{lead}</p>

    {#if codeFits}
      <div class="qr"><QrCode text={address} label={t('builds:install.qrLabel')} size="15rem" /></div>
    {:else if plan.qr}
      <p class="muted text-sm" role="status">{t('builds:install.qrTooLong')}</p>
    {/if}

    {#if address}
      <div class="field">
        <label for="install-link" class="label">{t('builds:install.linkLabel')}</label>
        <div class="row">
          <input id="install-link" class="mono" type="text" readonly value={address} onfocus={(e) => e.currentTarget.select()} aria-describedby="install-link-hint" />
          <CopyButton value={address} size="md" variant="secondary" />
        </div>
        <p id="install-link-hint" class="muted text-xs">{t('builds:install.linkHint')}</p>
      </div>
    {/if}

    <div class="actions">
      {#if build.expoUrl}
        <Button icon="external-link" href={build.expoUrl} target="_blank">{t('builds:install.openExpo')}</Button>
      {/if}
      {#if file}
        <Button icon="download" href={file.href} target="_blank">
          {file.kind === 'file' ? t('builds:install.download') : t('builds:install.downloadKind', { kind: `.${file.kind}` })}
        </Button>
      {/if}
      {#if orbit}
        <Tooltip text={t('builds:install.orbitTip')}>
          {#snippet children(tip)}
            <span {...tip} class="orbit" onclick={() => (orbitTried = true)} onkeydown={() => (orbitTried = true)} role="presentation">
              <Button icon="monitor" href={orbit} variant="secondary">{t('builds:install.orbit')}</Button>
            </span>
          {/snippet}
        </Tooltip>
      {/if}
    </div>
    {#if file}<p class="muted text-xs">{t('builds:install.downloadNote')}</p>{/if}
    {#if orbit && orbitTried}
      <p class="muted text-sm" role="status">
        {t('builds:install.orbitHint')}
        <a href={ORBIT_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">{t('builds:install.orbitGet')}<Icon name="external-link" size={12} /></a>
      </p>
    {/if}

    {#if build.artifactExpiresAt !== null}
      <p class="muted text-sm">{t('builds:install.expires', { date: fullTime(build.artifactExpiresAt) })}</p>
    {/if}

    {#if build.platform === 'android'}
      <Disclosure summary={t('builds:install.helpAndroid')}>
        <ul class="help text-sm">
          <li>{t('builds:install.androidNew')}</li>
          <li>{t('builds:install.androidOld')}</li>
        </ul>
      </Disclosure>
    {:else if build.platform === 'ios'}
      <Disclosure summary={t('builds:install.helpIos')}>
        <ul class="help text-sm">
          <li>{t('builds:install.iosAdHoc')}</li>
          <li>{t('builds:install.iosTrust')}</li>
          <li><a href={INTERNAL_DISTRIBUTION_DOCS_URL} target="_blank" rel="noopener noreferrer">{t('builds:install.iosDocs')}<Icon name="external-link" size={12} /></a></li>
        </ul>
      </Disclosure>
    {/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('common:action.close')}</Button>
  {/snippet}
</Modal>

<style>
  .lead {
    margin: 0;
  }

  .qr {
    display: flex;
    justify-content: center;
  }

  .label {
    font-weight: 600;
  }

  input.mono {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .orbit {
    display: inline-flex;
  }

  .help {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  p {
    margin: 0;
  }
</style>
