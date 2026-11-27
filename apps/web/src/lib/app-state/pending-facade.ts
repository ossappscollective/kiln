/**
 * The facade of the pending / publish / nav surfaces: the one file the components import the cart, publish and nav stores through.
 *
 * The component guard (R7) allows a component to reach a state store only through `lib/app-state/`, so every screen that draws a count of
 * the pending cart, the publish run or the nav badges is listed in one place: the model (`appStateStore`) decides the numbers, and these
 * stores hold what the screens need to DRAW them (the expanded rows of a cart, the button's press state, the nav lists the pages
 * publish). A store that is not exported here is not reachable from a component.
 *
 * Adding a store to the list is a decision about the model, not about convenience: say in the commit why the model cannot hand it over.
 */
export { cartButton, resetCartButton } from '../cart-button.svelte.ts';
export { cartDetailStore } from '../cart-preview.svelte.ts';
export {
  type Expanded,
  expansionOf,
  noneExpanded,
  PREVIEW_KEYS,
  previewOf,
  pruneExpanded,
  toggleAll,
  toggleExpanded,
} from '../cart-preview.ts';
export { KIND_LABEL, pendingAcrossText } from '../cart-summary.ts';
export { navSignals } from '../nav-signals.svelte.ts';
export { pendingStore } from '../pending-store.svelte.ts';
export { publishingStore } from '../publishing-store.svelte.ts';
export { stagedStore } from '../staged-store.svelte.ts';
export { submitStore } from '../store-submit-store.svelte.ts';
