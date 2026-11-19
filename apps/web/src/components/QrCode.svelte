<!--
  QrCode: draws a QR code for a short text (lib/qr.ts, no network, no library). Used for the otpauth:// link of an authenticator app,
  which is a secret: it is drawn here, in the page, and never sent anywhere.
  Props: text, label (the accessible name), size? (CSS width, default 12rem).
-->
<script lang="ts">
  import { qrMatrix, qrPath } from '../lib/qr.ts';

  let { text, label, size = '12rem' }: { text: string; label: string; size?: string } = $props();

  const code = $derived.by(() => {
    const matrix = qrMatrix(text);
    return matrix ? qrPath(matrix) : null;
  });
</script>

{#if code}
  <div class="qr" style:width={size}>
    <svg viewBox="0 0 {code.size} {code.size}" role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={code.size} height={code.size} fill="#fff" />
      <path d={code.d} fill="#000" />
    </svg>
  </div>
{/if}

<style>
  .qr {
    max-width: 100%;
  }

  svg {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
</style>
