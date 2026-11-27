import type { Platform, Role } from '@kiln/core';
import { getContext, setContext } from 'svelte';
import type { Api } from './api.ts';

/**
 * What the "Copy review information from 1.19.0" button needs from the screen that lists the blockers of a submit: the api, the
 * workspace, the app, the role when it is known, and what to do once the copy is made (read the checklist again). A screen that lists
 * blockers (the submit checklist, the publish dialog) provides it; the lists inside it (`SubmitPreviewBody`, `SubmitReadiness`) read it,
 * so no list needs to be handed the api. Without a provider a blocker about the review information is text and a link only.
 */
export type ReviewRepair = {
  api: Api;
  workspaceId: string;
  /** Null: not known here (the server still refuses a role that may not write). */
  role: Role | null;
  app: { id: string; name: string; platform: Platform };
  /** Called after a copy was made: the provider reads its own state again. */
  onrepaired: () => void;
};

const KEY = Symbol('review-repair');

export const provideReviewRepair = (repair: () => ReviewRepair): void => {
  setContext(KEY, repair);
};

export const reviewRepair = (): (() => ReviewRepair) | undefined =>
  getContext<(() => ReviewRepair) | undefined>(KEY);
