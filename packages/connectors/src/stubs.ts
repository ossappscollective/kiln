import type { ChangeSet } from '@kiln/core';
import {
  type DispatchResult,
  type ListWorkflowRunsOptions,
  NotImplementedError,
  type ProposalResult,
  type ProposeOptions,
  type RepoConnector,
  type WorkflowRun,
} from './types.ts';

/** Phase 1. A local clone: edit, diff and commit on disk. */
export class LocalCloneRepoConnector implements RepoConnector {
  readonly kind = 'local' as const;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  listFiles(_ref?: string): Promise<string[]> {
    throw new NotImplementedError('LocalCloneRepoConnector.listFiles');
  }
  readFile(_path: string, _ref?: string): Promise<string | undefined> {
    throw new NotImplementedError('LocalCloneRepoConnector.readFile');
  }
  propose(_changeSet: ChangeSet, _options: ProposeOptions): Promise<ProposalResult> {
    throw new NotImplementedError('LocalCloneRepoConnector.propose');
  }
  dispatchWorkflow(
    _workflow: string,
    _ref: string,
    _inputs?: Record<string, string>,
  ): Promise<DispatchResult> {
    throw new NotImplementedError('LocalCloneRepoConnector.dispatchWorkflow');
  }
  listWorkflowRuns(_options?: ListWorkflowRunsOptions): Promise<WorkflowRun[]> {
    throw new NotImplementedError('LocalCloneRepoConnector.listWorkflowRuns');
  }
}
