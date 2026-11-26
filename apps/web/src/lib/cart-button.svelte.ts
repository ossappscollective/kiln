/**
 * The UI plumbing of the pending cart button, which lives in the top bar (Shell) while the cart itself (PendingCart, ADR 0054) lives
 * inside the app page: how to open the drawer, whether it is open, the pulse, which records it covers. PendingCart writes it, the button
 * reads it; leaving the app clears it. What the button SAYS (pending, publishing, failed, the count) is not here: it comes from the
 * state model (`appStateStore.topBar`), so the top bar can never disagree with a page.
 */
export const cartButton = $state<{
  expanded: boolean;
  pulse: boolean;
  press: (() => void) | null;
  /** The records of the open app's cart (what its drawer covers), so the button knows whether a running publish is shown in it. */
  appIds: string[];
}>({
  expanded: false,
  pulse: false,
  press: null,
  appIds: [],
});

export function resetCartButton(): void {
  cartButton.expanded = false;
  cartButton.pulse = false;
  cartButton.press = null;
  cartButton.appIds = [];
}
