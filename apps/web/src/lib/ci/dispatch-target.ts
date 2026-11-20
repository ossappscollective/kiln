import type { Platform } from '@mrm/core';
import { initialSelection } from './dispatch-apps.ts';
import type { DispatchHint } from '../start-release.ts';
import type { AppSummary, CiWorkflow, RepositorySummary } from '../types.ts';
import { suggestAppId } from './workflows.ts';

/**
 * What every entry point hands to the one DispatchDialog (components/ci/DispatchDialog.svelte): the repository, the workflow, the
 * platforms the workflow is for (to suggest an app) and an optional hint for the inputs. The dialog reads the apps of the workspace
 * itself, so every entry point shows the same fields: workflow, branch or tag, the inputs, and "For apps" (several apps; none means
 * every app of the repository). Pure. Written for the ES2017 web build.
 */
export type DispatchTarget = {
  repository: RepositorySummary;
  workflow: CiWorkflow;
  /** The platforms the workflow builds, when known: with one app of that platform in the repository it is preselected. */
  platforms: readonly Platform[];
  /** An app to preselect when it belongs to the repository ('' for none). */
  appId: string;
  hint?: DispatchHint;
};

/** The props of the dialog, in one place. A test makes sure every entry point passes exactly these. */
export const DISPATCH_DIALOG_PROPS: readonly string[] = [
  'api',
  'workspaceId',
  'target',
  'onclose',
  'ondispatched',
];

export function dispatchTarget(input: {
  repository: RepositorySummary;
  workflow: CiWorkflow;
  platforms?: readonly Platform[];
  appId?: string;
  hint?: DispatchHint;
}): DispatchTarget {
  return {
    repository: input.repository,
    workflow: input.workflow,
    platforms: input.platforms ?? [],
    appId: input.appId ?? '',
    ...(input.hint ? { hint: input.hint } : {}),
  };
}

/** The apps ticked when the dialog opens: the named app, else the one the platforms point to, else none. */
export function dispatchPreselection(
  apps: readonly AppSummary[],
  target: DispatchTarget,
): string[] {
  const own = apps.filter((a) => a.repositoryId === target.repository.id);
  return initialSelection(
    own,
    target.appId !== '' ? target.appId : suggestAppId(apps, target.repository.id, target.platforms),
  );
}

/** The apps a run of this repository can be tied to. */
export const dispatchLinkableApps = (
  apps: readonly AppSummary[],
  repositoryId: string,
): AppSummary[] => apps.filter((a) => a.repositoryId === repositoryId);
