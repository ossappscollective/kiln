import type { Platform } from '@kiln/core';
import type { Api } from '../api.ts';
import { loadShowEvents, saveShowEvents } from './markers-pref.ts';
import { entriesOf, type TimelineEntry, windowFor } from './timeline.ts';

/** The events drawn as markers on the Insights charts: read only while the toggle is on, one read per app record, newest read wins. */
export class EventLayer {
  show = $state(false);
  entries = $state<Record<string, TimelineEntry[]>>({});
  failed = $state(false);
  private generation = 0;
  private readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;
    this.show = loadShowEvents(userId);
  }

  set(on: boolean): void {
    this.show = on;
    saveShowEvents(this.userId, on);
  }

  for(appId: string): TimelineEntry[] {
    return this.entries[appId] ?? [];
  }

  async load(
    api: Api,
    workspaceId: string,
    members: readonly { id: string; platform: Platform }[],
    from: string,
    to: string,
  ): Promise<void> {
    const mine = ++this.generation;
    const w = windowFor(from, to);
    let failed = false;
    const next: Record<string, TimelineEntry[]> = {};
    await Promise.all(
      members.map(async (m) => {
        try {
          const v = await api.appTimeline(workspaceId, m.id, w.from, w.to);
          next[m.id] = entriesOf([{ app: { id: m.id, platform: m.platform }, events: v.events }]);
        } catch {
          failed = true;
        }
      }),
    );
    if (mine !== this.generation) return;
    this.entries = next;
    this.failed = failed;
  }
}
