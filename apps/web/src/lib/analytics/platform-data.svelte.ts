import type { Platform } from '@kiln/core';
import type { Api } from '../api.ts';
import { type AnalyticsStatus, analyticsErrorText, type ResolvedRange } from './analytics.ts';
import { type Extras, loadExtras } from './extras.ts';
import { type Loaded, loadOverviews } from './load.ts';
import { hasStoredData } from './view.ts';

/**
 * What the Insights overview reads for ONE app record (one platform): the status of its analytics sources and, when something is stored, the
 * overview of the period (with the previous one for the comparison) and the two extra cards. It lives in the section, not in a part of the
 * page, so the figures above the rail and each section of the rail share one read per platform. Reading never reaches a store. A new app,
 * workspace or range reads again; a range change keeps what is drawn (`refreshing`) instead of blanking it.
 */
export class PlatformData {
  status = $state<AnalyticsStatus | null>(null);
  loaded = $state<Loaded | null>(null);
  extra = $state<Extras>({ earnings: null, subscriptions: null });
  statusError = $state('');
  overviewError = $state('');
  loading = $state(true);
  refreshing = $state(false);

  #generation = 0;
  #shownApp = '';

  get stored(): boolean {
    return hasStoredData(this.status);
  }

  /** Reads again when `key` (workspace, app, range) changed since the last call; `appKey` tells a range change from a new app. */
  ensure(
    api: Api,
    workspaceId: string,
    app: { id: string; platform: Platform },
    range: ResolvedRange,
    now: number,
  ): void {
    const appKey = `${workspaceId}/${app.id}`;
    const keep = this.#shownApp === appKey && this.status !== null;
    this.#shownApp = appKey;
    void this.load(api, workspaceId, app, range, now, keep);
  }

  async load(
    api: Api,
    workspaceId: string,
    app: { id: string; platform: Platform },
    range: ResolvedRange,
    now: number,
    keepFrame: boolean,
  ): Promise<void> {
    const mine = ++this.#generation;
    if (!keepFrame) {
      this.status = null;
      this.loaded = null;
      this.extra = { earnings: null, subscriptions: null };
    }
    this.loading = !keepFrame;
    this.refreshing = true;
    this.statusError = '';
    this.overviewError = '';
    try {
      const next = await api.analyticsStatus(workspaceId, app.id);
      if (mine !== this.#generation) return;
      this.status = next;
      if (hasStoredData(next)) {
        try {
          const both = await loadOverviews(api, workspaceId, app, range);
          if (mine !== this.#generation) return;
          this.loaded = both;
          // The two extra cards have their own reads; a failed one only drops its card.
          const more = await loadExtras(api, workspaceId, app, next, range, now);
          if (mine !== this.#generation) return;
          this.extra = more;
        } catch (e) {
          if (mine !== this.#generation) return;
          this.overviewError = analyticsErrorText(e);
        }
      } else {
        this.loaded = null;
        this.extra = { earnings: null, subscriptions: null };
      }
    } catch (e) {
      if (mine !== this.#generation) return;
      this.statusError = analyticsErrorText(e);
    } finally {
      if (mine === this.#generation) {
        this.loading = false;
        this.refreshing = false;
      }
    }
  }
}
