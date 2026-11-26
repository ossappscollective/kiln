/**
 * "Fix the blockers, then submit": a request to open the submit checklist (the preview of SubmitReady, with the blockers the store
 * reports) for an app. One request at a time; it is answered once, by the first SubmitReady of that app that is drawn and may act (or at
 * once when it already is). `SubmitReady` registers itself while it is drawn so that the opener knows whether to go to the Listing page,
 * where it is.
 */
let requested = $state<string | null>(null);
const drawn = new Map<string, number>();

export const submitFocus = {
  /** The app whose submit checklist should open, or null. Reactive. */
  get requested(): string | null {
    return requested;
  },
  ask(appId: string): void {
    requested = appId;
  },
  /** The checklist of `appId` was opened: the request is answered. */
  done(appId: string): void {
    if (requested === appId) requested = null;
  },
  /** A SubmitReady of `appId` is drawn; the returned function says it is gone. */
  mount(appId: string): () => void {
    drawn.set(appId, (drawn.get(appId) ?? 0) + 1);
    return () => {
      const left = (drawn.get(appId) ?? 1) - 1;
      if (left <= 0) drawn.delete(appId);
      else drawn.set(appId, left);
    };
  },
  isDrawn(appId: string): boolean {
    return (drawn.get(appId) ?? 0) > 0;
  },
};
