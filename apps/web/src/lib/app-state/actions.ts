import { PUBLISH_STEPS, type LastPublish, type PublishStepType } from '../pending.ts';

/**
 * The two requests a screen can make of the pending panel without owning it (docs/state-model.md): "publish again" (the card, the top bar)
 * and "show me the pending changes on the failure". Plain window events, like `kiln:cart-open`: the cart of the open app answers them.
 * Pure helpers here; the Svelte side is `panel.svelte.ts`.
 */

/** The name of the window event "Publish again" sends; its detail is `{ appId }`. */
export const PUBLISH_AGAIN_EVENT = 'kiln:publish-again';

/** Asks the open app's cart to open the publish dialog for this record again. False when there is no window or nothing listened. */
export function requestPublishAgain(
  appId: string,
  target: Pick<EventTarget, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window,
): boolean {
  if (target === null) return false;
  return target.dispatchEvent(new CustomEvent(PUBLISH_AGAIN_EVENT, { detail: { appId }, cancelable: true })) === false;
}

/**
 * The steps "Publish again" starts with, from the run that failed: a run that only pushed the draft goes back to the draft alone; any
 * other run opens the whole plan (the dialog lists each step with its own tick, so nothing runs that the person did not see).
 */
export function stepsToRepeat(run: Pick<LastPublish, 'steps'> | null): PublishStepType[] | null {
  if (run === null) return null;
  const known = run.steps.filter((s) => PUBLISH_STEPS.indexOf(s) >= 0);
  return known.length === 1 && known[0] === 'push_draft' ? ['push_draft'] : null;
}
