<!--
  TestFlightLinks: the "TestFlight" row of a store build. READ ONLY: it shows the external TestFlight groups that already have a public
  link (group name, link with a copy button and a QR code, whether the link is on, the tester limit). When there is none it says so;
  it never creates a group or turns a link on. A link that is switched off is shown as off and has no code.
  Props: view (a `links` or `message` TestFlightView).
-->
<script lang="ts">
  import { qrMatrix, qrPath } from '../../lib/qr.ts';
  import type { TestFlightView } from '../../lib/builds.ts';
  import Badge from '../ui/Badge.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Disclosure from '../ui/Disclosure.svelte';

  let { view }: { view: Exclude<TestFlightView, { kind: 'hidden' }> } = $props();

  const code = (link: string | null) => {
    const matrix = link ? qrMatrix(link) : null;
    return matrix ? qrPath(matrix) : null;
  };
</script>

<div class="tf">
  <span class="label">TestFlight</span>
  {#if view.kind === 'message'}
    <span class="muted text-sm">{view.text}</span>
  {:else}
    {#each view.links as link (link.id)}
      {@const qr = link.enabled ? code(link.publicLink) : null}
      <div class="group">
        <span class="line">
          <strong>{link.name}</strong>
          <Badge tone={link.enabled ? 'ok' : 'neutral'} dot>{link.stateText}</Badge>
          <span class="muted text-sm">{link.limitText}</span>
        </span>
        {#if link.publicLink}
          <span class="line">
            <a class="url text-sm" href={link.publicLink} target="_blank" rel="noopener noreferrer">{link.publicLink}<span class="visually-hidden"> (opens in a new tab)</span></a>
            <CopyButton value={link.publicLink} label="Copy the TestFlight link of {link.name}" iconOnly size="sm" />
          </span>
          {#if !link.enabled}<span class="muted text-sm">Switched off in App Store Connect: testers cannot join with it.</span>{/if}
          {#if qr}
            <Disclosure summary="QR code">
              <svg class="qr" viewBox="0 0 {qr.size} {qr.size}" role="img" aria-label="QR code with the TestFlight link of {link.name}" shape-rendering="crispEdges">
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.d} fill="#000" />
              </svg>
            </Disclosure>
          {/if}
        {:else}
          <span class="muted text-sm">The store gave no link address for this group.</span>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .tf {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .label {
    font-size: var(--text-xs, 0.75rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .url {
    overflow-wrap: anywhere;
  }

  .qr {
    width: 9rem;
    height: 9rem;
    background: #fff;
  }
</style>
