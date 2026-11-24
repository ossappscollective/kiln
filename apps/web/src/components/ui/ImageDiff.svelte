<!--
  ImageDiff: a before and an after image compared (docs/adr/0067-diff-and-preview.md). Modes: side by side, swipe (a slider reveals the
  before image over the after image), fade (an opacity slider), difference (CSS mix-blend-mode: difference, identical pixels turn
  black). Zoom: fit or 100%. Under the pictures: pixel size, file size and, when both load and have the same shape, about how many
  pixels differ (drawn on a canvas of at most 512px; both addresses are the server's own, never an external one).
  A missing side is said in words (new asset: no image before; removed: no image after) and a failed load is an explicit state.
  The sliders are native range inputs (arrow keys, Home and End). No motion is used, so reduced motion is respected.
  Props: before, after ({ url, width?, height?, bytes?, name? } or null), beforeLabel, afterLabel, mode (bindable), zoom (bindable).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import { formatBytes } from '../../lib/assets/assets.ts';
  import {
    canvasSize,
    changedRatio,
    clampPercent,
    dimensionsText,
    hasImage,
    type ImageMode,
    type ImageSide,
    MODES,
    pairState,
    percentText,
    sameShape,
  } from '../../lib/diff/image-diff.ts';

  let {
    before,
    after,
    beforeLabel,
    afterLabel,
    mode = $bindable('side'),
    zoom = $bindable('fit'),
  }: {
    before: ImageSide | null;
    after: ImageSide | null;
    beforeLabel: string;
    afterLabel: string;
    mode?: ImageMode | undefined;
    zoom?: 'fit' | 'actual' | undefined;
  } = $props();

  type Load = 'loading' | 'ok' | 'failed';
  let beforeLoad = $state<Load>('loading');
  let afterLoad = $state<Load>('loading');
  let beforeNatural = $state<{ width: number; height: number } | null>(null);
  let afterNatural = $state<{ width: number; height: number } | null>(null);
  let beforeImg = $state<HTMLImageElement>();
  let afterImg = $state<HTMLImageElement>();
  let position = $state(50);
  let changed = $state<number | null>(null);

  // A new pair: forget the load state of the last one.
  $effect(() => {
    void before?.url;
    void after?.url;
    beforeLoad = hasImage(before) ? 'loading' : 'ok';
    afterLoad = hasImage(after) ? 'loading' : 'ok';
    beforeNatural = null;
    afterNatural = null;
    beforeImg = undefined;
    afterImg = undefined;
    changed = null;
  });

  const pstate = $derived(pairState({ before, after }));
  const comparable = $derived(pstate === 'changed' && beforeLoad === 'ok' && afterLoad === 'ok');
  const modes = $derived(comparable ? MODES : (['side'] as const));
  const MODE_KEYS: Record<ImageMode, string> = {
    side: k('common:diff.image.mode.side'),
    swipe: k('common:diff.image.mode.swipe'),
    fade: k('common:diff.image.mode.fade'),
    difference: k('common:diff.image.mode.difference'),
  };
  const modeLabel = (m: ImageMode) => t(MODE_KEYS[m]);
  const shown = $derived(comparable ? mode : 'side');

  const dims = (s: ImageSide | null, n: { width: number; height: number } | null) =>
    dimensionsText(s && s.width && s.height ? s : n ? n : null);
  const facts = (s: ImageSide | null, n: { width: number; height: number } | null) =>
    [dims(s, n), s?.bytes ? formatBytes(s.bytes) : ''].filter(Boolean).join(' · ');
  const sizesDiffer = $derived(
    comparable && beforeNatural !== null && afterNatural !== null && (beforeNatural.width !== afterNatural.width || beforeNatural.height !== afterNatural.height),
  );

  function loaded(side: 'before' | 'after', img: HTMLImageElement) {
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    if (side === 'before') {
      beforeLoad = 'ok';
      beforeImg = img;
      beforeNatural = natural;
    } else {
      afterLoad = 'ok';
      afterImg = img;
      afterNatural = natural;
    }
  }

  // "Changed pixels": only when both are there, have the same shape and the draw is allowed (same origin pictures only).
  $effect(() => {
    if (!comparable || !beforeImg || !afterImg || !beforeNatural || !afterNatural) return;
    if (!sameShape(beforeNatural, afterNatural)) return;
    const a = beforeImg;
    const b = afterImg;
    const size = canvasSize(afterNatural.width, afterNatural.height);
    const id = setTimeout(() => {
      try {
        const draw = (img: HTMLImageElement) => {
          const canvas = document.createElement('canvas');
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return null;
          ctx.drawImage(img, 0, 0, size.width, size.height);
          return ctx.getImageData(0, 0, size.width, size.height).data;
        };
        const x = draw(a);
        const y = draw(b);
        changed = x && y ? changedRatio(x, y) : null;
      } catch {
        changed = null;
      }
    }, 0);
    return () => clearTimeout(id);
  });
</script>

<div class="image-diff" data-testid="image-diff">
  <div class="bar">
    {#if modes.length > 1}
      <div class="group" role="group" aria-label={t('common:diff.image.modeLabel')}>
        {#each modes as m (m)}
          <button type="button" class="seg" class:on={shown === m} aria-pressed={shown === m} onclick={() => (mode = m)}>{modeLabel(m)}</button>
        {/each}
      </div>
    {/if}
    <div class="group" role="group" aria-label={t('common:diff.image.zoomLabel')}>
      <button type="button" class="seg" class:on={zoom === 'fit'} aria-pressed={zoom === 'fit'} onclick={() => (zoom = 'fit')}>{t('common:diff.image.fit')}</button>
      <button type="button" class="seg" class:on={zoom === 'actual'} aria-pressed={zoom === 'actual'} onclick={() => (zoom = 'actual')}>100%</button>
    </div>
  </div>

  {#if pstate === 'new'}<p class="note">{t('common:diff.image.new')}</p>{/if}
  {#if pstate === 'removed'}<p class="note">{t('common:diff.image.removed')}</p>{/if}
  {#if pstate === 'none'}<p class="note">{t('common:diff.image.none')}</p>{/if}

  <div class="stage" class:actual={zoom === 'actual'}>
    {#if shown === 'side'}
      <div class="pair">
        {#each [{ side: 'before' as const, s: before, label: beforeLabel, load: beforeLoad }, { side: 'after' as const, s: after, label: afterLabel, load: afterLoad }] as p (p.side)}
          <figure>
            <figcaption>{p.label}</figcaption>
            {#if hasImage(p.s)}
              {#if p.load === 'failed'}
                <p class="failed" role="alert">{t('common:diff.image.failed')}</p>
              {:else}
                <img
                  src={p.s.url}
                  alt={p.label}
                  class:loading={p.load === 'loading'}
                  onload={(e) => loaded(p.side, e.currentTarget as HTMLImageElement)}
                  onerror={() => (p.side === 'before' ? (beforeLoad = 'failed') : (afterLoad = 'failed'))}
                />
                {#if p.load === 'loading'}<p class="muted">{t('common:diff.image.loading')}</p>{/if}
              {/if}
            {:else}
              <p class="empty">{p.side === 'before' ? t('common:diff.image.noBefore') : t('common:diff.image.noAfter')}</p>
            {/if}
            <p class="facts muted">{facts(p.s, p.side === 'before' ? beforeNatural : afterNatural)}</p>
          </figure>
        {/each}
      </div>
    {:else}
      <div class="overlay" class:blend={shown === 'difference'}>
        <img class="base" src={before?.url ?? ''} alt={beforeLabel} />
        <img
          class="top"
          src={after?.url ?? ''}
          alt={afterLabel}
          style={shown === 'swipe' ? `clip-path: inset(0 0 0 ${position}%)` : shown === 'fade' ? `opacity: ${position / 100}` : undefined}
        />
      </div>
      {#if shown === 'swipe' || shown === 'fade'}
        <label class="slider">
          <span>{shown === 'swipe' ? t('common:diff.image.swipe') : t('common:diff.image.fade')}</span>
          <input type="range" min="0" max="100" step="1" value={position} oninput={(e) => (position = clampPercent(Number(e.currentTarget.value)))} />
          <span class="muted" aria-hidden="true">{beforeLabel} {position}% {afterLabel}</span>
        </label>
      {:else}
        <p class="muted">{t('common:diff.image.differenceHint')}</p>
      {/if}
    {/if}
  </div>

  {#if comparable}
    <p class="muted hint">
      {#if sizesDiffer && beforeNatural && afterNatural}{t('common:diff.image.sizesDiffer', { before: dimensionsText(beforeNatural), after: dimensionsText(afterNatural) })}{/if}
      {#if changed !== null}{changed === 0 ? t('common:diff.image.samePixels') : t('common:diff.image.changedPixels', { percent: percentText(changed) })}{/if}
    </p>
  {/if}
</div>

<style>
  .image-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }
  .group {
    display: inline-flex;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .seg {
    padding: var(--space-1) var(--space-3);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--ink);
    background: var(--surface);
    border: 0;
    border-right: 1px solid var(--line);
    cursor: pointer;
  }
  .seg:last-child {
    border-right: 0;
  }
  .seg.on {
    color: var(--chip-ink);
    background: var(--chip-bg);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .seg:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  p {
    margin: 0;
    font-size: var(--text-sm);
  }
  .note {
    padding: var(--space-2) var(--space-3);
    color: var(--info-ink);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    border-radius: var(--radius-md);
  }
  .stage {
    max-height: 60vh;
    overflow: auto;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    align-items: start;
  }
  figure {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  figcaption {
    font-size: var(--text-xs);
    color: var(--muted);
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    background: var(--surface);
    border: 1px solid var(--line);
  }
  .actual img {
    max-width: none;
  }
  img.loading {
    min-height: 80px;
    min-width: 40px;
  }
  .empty,
  .failed {
    padding: var(--space-4);
    text-align: center;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-md);
    color: var(--muted);
  }
  .failed {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }
  .overlay {
    display: grid;
    width: fit-content;
    max-width: 100%;
    isolation: isolate;
    background: var(--ground);
  }
  .overlay img {
    grid-area: 1 / 1;
  }
  .overlay.blend .top {
    mix-blend-mode: difference;
  }
  .slider {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    font-size: var(--text-sm);
  }
  .slider input {
    flex: 1;
    min-width: 160px;
  }
  .facts {
    min-height: 1.2em;
  }
  @media (max-width: 640px) {
    .pair {
      grid-template-columns: 1fr;
    }
  }
</style>
