import type { Api } from './api.ts';
import { readCache } from './read-cache.ts';
import type { AppPipeline, PipelineSummary } from './release-pipeline.ts';
import { stagingError } from './staged.ts';

/**
 * What the screens know about the release pipeline (docs/api/release-pipeline.md): the workspace summary (one line per app,
 * for the overview, the attention lists and the sidebar badges) and, per app, the pipeline the five-step strip draws. Both are
 * reads of our own database. A read that started before a newer one arrived is dropped. A failed read leaves what there was and
 * says so, so a screen draws nothing rather than something old and wrong; no screen needs it to work.
 */
let summaries = $state<Record<string, PipelineSummary | undefined>>({});
let summaryFailed = $state<Record<string, boolean | undefined>>({});
let apps = $state<Record<string, AppPipeline | undefined>>({});
const summaryGeneration: Record<string, number> = {};
const appGeneration: Record<string, number> = {};

export const pipelineStore = {
  summary(workspaceId: string): PipelineSummary | null {
    return summaries[workspaceId] ?? null;
  },
  summaryFailed(workspaceId: string): boolean {
    return summaryFailed[workspaceId] === true;
  },
  /** Reads the workspace summary. Returns '' when it worked, else a sentence. */
  async loadSummary(api: Api, workspaceId: string): Promise<string> {
    const mine = (summaryGeneration[workspaceId] = (summaryGeneration[workspaceId] ?? 0) + 1);
    try {
      const out = await api.releasePipelineSummary(workspaceId);
      if (mine === summaryGeneration[workspaceId]) {
        summaries[workspaceId] = out;
        summaryFailed[workspaceId] = false;
      }
      return '';
    } catch (e) {
      if (mine === summaryGeneration[workspaceId]) summaryFailed[workspaceId] = true;
      return stagingError(e);
    }
  },
  app(appId: string): AppPipeline | null {
    return apps[appId] ?? null;
  },
  /** Reads one app's pipeline. Returns '' when it worked, else a sentence. */
  async loadApp(api: Api, workspaceId: string, appId: string, force = false): Promise<string> {
    const mine = (appGeneration[appId] = (appGeneration[appId] ?? 0) + 1);
    try {
      // The same key as the release stepper's read, so a page that shows both asks once.
      const out = await readCache.read({
        workspaceId,
        group: 'pipeline',
        key: `pipeline/${appId}`,
        force,
        load: () => api.releasePipeline(workspaceId, appId),
      });
      if (mine === appGeneration[appId]) apps[appId] = out;
      return '';
    } catch (e) {
      return stagingError(e);
    }
  },
};
