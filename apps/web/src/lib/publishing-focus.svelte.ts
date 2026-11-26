import type { PlatformScope } from './app-scope.ts';
import { cartButton } from './cart-button.svelte.ts';
import { panelTarget } from './publishing.ts';

/**
 * "Show me the publish": opens the pending panel (the cart drawer of the open app when it covers the app, else the app's Pending page)
 * and asks the status row of that app to scroll into view and take focus (`PublishingStatus` answers the request when it is drawn, or
 * at once when it already is). One request at a time; it is answered once.
 */
let requested = $state<string | null>(null);
/** The app whose FAILURE block should come into view (the top bar's "Publish failed", the card's "Show pending changes"). */
let failureRequested = $state<string | null>(null);

export const publishingFocus = {
  /** The app whose status row should come into view, or null. Reactive. */
  get requested(): string | null {
    return requested;
  },
  ask(appId: string): void {
    requested = appId;
  },
  /** The row of `appId` was shown: the request is answered. */
  done(appId: string): void {
    if (requested === appId) requested = null;
  },
  /** The app whose failure block should come into view, or null. Reactive. */
  get failureRequested(): string | null {
    return failureRequested;
  },
  askFailure(appId: string): void {
    failureRequested = appId;
  },
  /** The failure block of `appId` was shown: the request is answered. */
  doneFailure(appId: string): void {
    if (failureRequested === appId) failureRequested = null;
  },
};

/** Opens the pending panel on the publish of `appId`. */
export function openPublishingPanel(appId: string, scope: PlatformScope | null = null): void {
  publishingFocus.ask(appId);
  const target = panelTarget({
    appId,
    drawerAppIds: cartButton.appIds,
    drawerReady: cartButton.press !== null,
    scope,
  });
  if (target.kind === 'drawer') cartButton.press?.();
  else location.hash = target.href;
}
