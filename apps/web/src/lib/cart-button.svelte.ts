/**
 * The state of the app's pending cart button, which lives in the top bar (Shell) while the cart itself (PendingCart, ADR 0054)
 * lives inside the app page. PendingCart writes it, the button in the top bar reads it; leaving the app clears it, so the
 * button exists only inside an app and only while changes wait.
 */
export const cartButton = $state<{
  visible: boolean;
  count: number;
  expanded: boolean;
  pulse: boolean;
  press: (() => void) | null;
  /** The records of the open app's cart (what its drawer covers), so the button knows whether a running publish is shown in it. */
  appIds: string[];
}>({
  visible: false,
  count: 0,
  expanded: false,
  pulse: false,
  press: null,
  appIds: [],
});

export function resetCartButton(): void {
  cartButton.visible = false;
  cartButton.count = 0;
  cartButton.expanded = false;
  cartButton.pulse = false;
  cartButton.press = null;
  cartButton.appIds = [];
}
