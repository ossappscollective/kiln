import type { Api } from './api.ts';
import { createSummaryLoader } from './cart-summary.ts';

/** The reactive wrapper of the workspace-wide pending count: `version` changes whenever the loader holds something new. */
let version = $state(0);
let current: Api | null = null;
const loader = createSummaryLoader({
  read: (workspaceId) => {
    if (current === null) return Promise.reject(new Error('no api'));
    return current.pendingCartSummary(workspaceId);
  },
  onChange: () => {
    version += 1;
  },
});

export const cartSummaryStore = {
  summaryOf(workspaceId: string) {
    void version;
    return loader.summaryOf(workspaceId);
  },
  /** Reads unless what is known is fresh (first paint, window focus). */
  ensure(api: Api, workspaceId: string): Promise<void> {
    current = api;
    return loader.ensure(workspaceId);
  },
  /** Something was staged, discarded or published: read again soon (a burst is one read). */
  request(api: Api, workspaceId: string): void {
    current = api;
    loader.request(workspaceId);
  },
  refresh(api: Api, workspaceId: string): Promise<void> {
    current = api;
    return loader.refresh(workspaceId);
  },
};
