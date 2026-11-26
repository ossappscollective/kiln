import { appAddress, type PlatformScope } from '../app-scope.ts';
import { cartButton } from '../cart-button.svelte.ts';
import { panelTarget } from '../publishing.ts';
import { openPublishingPanel, publishingFocus } from '../publishing-focus.svelte.ts';
import { submitFocus } from '../submit-focus.svelte.ts';

/**
 * Opens the pending panel on the FAILURE of an app's last publish (the top bar's "Publish failed", the Next step card's "Show pending
 * changes"): the cart drawer of the open app when it covers that app, else its Pending page, with the failure block scrolled into view
 * and focused (`FailureAnchor`). The twin of `openPublishingPanel`, which does the same for a publish that runs.
 */
export function openFailurePanel(appId: string, scope: PlatformScope | null = null): void {
  publishingFocus.askFailure(appId);
  const target = panelTarget({
    appId,
    drawerAppIds: cartButton.appIds,
    drawerReady: cartButton.press !== null,
    scope,
  });
  if (target.kind === 'drawer') cartButton.press?.();
  else location.hash = target.href;
}

/** Opens the pending panel for a state's "show_pending" action: on the running publish, on the failure, or just the pending changes. */
export function openPendingPanel(
  kind: 'publishing' | 'failed' | 'pending',
  appId: string,
  scope: PlatformScope | null = null,
): void {
  if (kind === 'publishing') return openPublishingPanel(appId, scope);
  if (kind === 'failed') return openFailurePanel(appId, scope);
  const target = panelTarget({
    appId,
    drawerAppIds: cartButton.appIds,
    drawerReady: cartButton.press !== null,
    scope,
  });
  if (target.kind === 'drawer') cartButton.press?.();
  else location.hash = target.href;
}

/**
 * Opens the submit checklist of an app (the preview with its blockers) for the "Fix the blockers, then submit" action: where a SubmitReady
 * of the app is already drawn it answers at once; otherwise the Listing page, where the pushed draft waits, is opened and its
 * SubmitReady answers when it is drawn.
 */
export function openSubmitChecklist(appId: string, scope: PlatformScope | null = null): void {
  submitFocus.ask(appId);
  if (!submitFocus.isDrawn(appId)) location.hash = appAddress(appId, 'listing', scope);
}
