import type { Api } from './api.ts';
import type { PendingItem } from './pending.ts';
import { isDetailKind, itemDetailKey, type PendingItemDetail } from './pending-preview.ts';

/**
 * The details of pending items that are not staged changes (a pushed draft, a draft release, a version in review or approved, a due
 * rollout step), read lazily when a row is first expanded and kept while the page lives (docs/adr/0067-diff-and-preview.md).
 */
export type ItemDetailEntry =
  | { status: 'loading' }
  | { status: 'ok'; detail: PendingItemDetail }
  | { status: 'failed' };

let entries = $state<Record<string, ItemDetailEntry>>({});

export const pendingItemDetailStore = {
  entryOf(
    appId: string,
    item: Pick<PendingItem, 'kind' | 'id' | 'since'>,
  ): ItemDetailEntry | undefined {
    return entries[itemDetailKey(appId, item)];
  },
  /** Reads the detail unless it is loading or loaded (or failed, unless `retry`). */
  async load(
    api: Api,
    workspaceId: string,
    appId: string,
    item: Pick<PendingItem, 'kind' | 'id' | 'since'>,
    retry = false,
  ): Promise<void> {
    if (!isDetailKind(item.kind)) return;
    const key = itemDetailKey(appId, item);
    const now = entries[key];
    if (now && !(retry && now.status === 'failed')) return;
    entries[key] = { status: 'loading' };
    try {
      const res = await api.appPendingItemDetail(workspaceId, appId, item.kind, item.id);
      entries[key] = { status: 'ok', detail: res.detail };
    } catch {
      entries[key] = { status: 'failed' };
    }
  },
};
