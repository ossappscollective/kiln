import type { Api } from './api.ts';
import { detailKey } from './cart-preview.ts';
import type { CartDetail, CartRow } from './pending-cart.ts';

/**
 * The details of cart rows, read lazily when a row is first expanded and kept while the page lives (docs/adr/0067-diff-and-preview.md).
 * Keyed by item AND version, so an item that changed is read again; a failed read is kept as `failed` until `load(..., true)`.
 */
export type DetailEntry =
  | { status: 'loading' }
  | { status: 'ok'; detail: CartDetail }
  | { status: 'failed' };

let entries = $state<Record<string, DetailEntry>>({});

export const cartDetailStore = {
  entryOf(row: Pick<CartRow, 'appId' | 'id' | 'version'>): DetailEntry | undefined {
    return entries[detailKey(row)];
  },
  /** Reads the detail unless it is loading or loaded (or failed, unless `retry`). */
  async load(
    api: Api,
    workspaceId: string,
    row: Pick<CartRow, 'appId' | 'id' | 'version'>,
    retry = false,
  ): Promise<void> {
    const key = detailKey(row);
    const now = entries[key];
    if (now && !(retry && now.status === 'failed')) return;
    entries[key] = { status: 'loading' };
    try {
      const res = await api.appPendingCartDetail(workspaceId, row.appId, row.id);
      entries[key] = { status: 'ok', detail: res.detail };
    } catch {
      entries[key] = { status: 'failed' };
    }
  },
};
