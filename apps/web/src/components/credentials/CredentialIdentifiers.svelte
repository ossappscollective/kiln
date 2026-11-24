<!--
  CredentialIdentifiers: the NON-SECRET identifiers of a saved credential (issuer and key id, service account e-mail, project id...),
  monospace, each with a copy button, so a person can check which account a credential belongs to. The server sends only an
  allow-list of fields (apps/server/src/services/credential-identifiers.ts): a secret is never here.
  Props: identifiers, effective? (values an app really uses, each with where it comes from: this credential, this app, the workspace
  default), compact? (no heading), aligned? (join the label column of the parent grid through a subgrid).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import type { EffectiveValue } from '../../lib/app-settings.ts';
  import type { CredentialIdentifier } from '../../lib/types.ts';
  import CopyValue from '../ui/CopyValue.svelte';

  let {
    identifiers,
    effective = [],
    compact = false,
    aligned = false,
  }: { identifiers: CredentialIdentifier[]; effective?: EffectiveValue[] | undefined; compact?: boolean | undefined; aligned?: boolean | undefined } = $props();

  const LABELS = {
    issuerId: k('credentials:identifier.issuerId'),
    keyId: k('credentials:identifier.keyId'),
    clientEmail: k('credentials:identifier.clientEmail'),
    projectId: k('credentials:identifier.projectId'),
    serviceKeyId: k('credentials:identifier.serviceKeyId'),
    clientId: k('credentials:identifier.clientId'),
    appId: k('credentials:identifier.appId'),
    installationId: k('credentials:identifier.installationId'),
    region: k('credentials:identifier.region'),
    tokenType: k('credentials:identifier.tokenType'),
  } as const;
  const TOKEN_TYPES = {
    classic: k('credentials:identifier.tokenKind.classic'),
    fine_grained: k('credentials:identifier.tokenKind.fineGrained'),
    oauth: k('credentials:identifier.tokenKind.oauth'),
    user_to_server: k('credentials:identifier.tokenKind.userToServer'),
    installation: k('credentials:identifier.tokenKind.installation'),
  } as const;

  const isLabelKey = (id: string): id is keyof typeof LABELS => Object.prototype.hasOwnProperty.call(LABELS, id);
  function labelOf(i: CredentialIdentifier): string {
    const id = i.key;
    return isLabelKey(id) ? t(LABELS[id]) : i.label;
  }
  const isTokenKind = (id: string): id is keyof typeof TOKEN_TYPES => Object.prototype.hasOwnProperty.call(TOKEN_TYPES, id);
  function valueOf(i: CredentialIdentifier): string {
    const id = i.value;
    return i.key === 'tokenType' && isTokenKind(id) ? t(TOKEN_TYPES[id]) : id;
  }
</script>

<div class="ids" class:aligned>
  {#if !compact}<p class="heading">{t('credentials:identifier.title')}</p>{/if}
  {#if identifiers.length === 0 && effective.length === 0}
    <p class="muted none">{t('credentials:identifier.none')}</p>
  {:else}
    <dl>
      {#each identifiers as i (i.key)}
        <div>
          <dt>{labelOf(i)}</dt>
          <dd>
            <CopyValue value={i.value} shown={valueOf(i)} copyable={i.copyable} copyLabel={t('credentials:identifier.copy', { label: labelOf(i) })} />
          </dd>
        </div>
      {/each}
      {#each effective as e (e.key)}
        <div>
          <dt>{e.label}</dt>
          <dd>
            <CopyValue value={e.value} note={e.origin} copyLabel={t('credentials:identifier.copy', { label: e.label })} />
          </dd>
        </div>
      {/each}
    </dl>
  {/if}
</div>

<style>
  .ids {
    min-width: 0;
    max-width: 100%;
  }

  .heading {
    margin: 0 0 var(--space-1);
    font-size: 0.8125rem;
    color: var(--muted);
  }

  .none {
    margin: 0;
    font-size: 0.875rem;
  }

  dl {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0;
    font-size: 0.875rem;
  }

  dl > div {
    display: contents;
  }

  dt {
    color: var(--muted);
  }

  dd {
    min-width: 0;
    margin: 0;
  }

  /* In the app Stores card the rows share the label column of the card (a subgrid), so every label and value lines up. */
  .aligned {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
  }

  .aligned dl {
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
  }

  .aligned .none {
    grid-column: 1 / -1;
  }

  @media (max-width: 519px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-1) var(--space-4);
    }

    dl > div + div > dt {
      margin-top: var(--space-2);
    }
  }
</style>
