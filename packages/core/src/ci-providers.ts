/**
 * The CI providers whose runs are stored side by side in `workflow_runs` and shown together (the pipeline, the builds, the running-now
 * list, alerts). One place for what a screen or a message needs to say about where a run lives, so nothing tests for a provider's name
 * to pick a word. A run carries `provider`; an unknown id (a newer server) reads as the first provider's words, never as an error.
 * Written for the ES2017 web build.
 */

export const CI_PROVIDERS = ['github', 'eas-workflows'] as const;
export type CiProviderId = (typeof CI_PROVIDERS)[number];

export type CiProviderMeta = {
  id: CiProviderId;
  /** The product: "GitHub Actions", "EAS Workflows". */
  label: string;
  /** Where its run pages live, in a sentence: "GitHub", "Expo". Used as in "Open on Expo". */
  host: string;
  /** What it calls a workflow definition in a sentence: "workflow". */
  workflowNoun: string;
  /** The jobs of a run can be read through `GET .../runs/:runId/jobs` (GitHub's jobs and steps), so a screen may offer to follow it. */
  readsJobs: boolean;
  /** Its workflows are listed from the repository connection and started from the repository's CI routes (not from the app's Expo routes). */
  listsWorkflows: boolean;
};

export const CI_PROVIDER_META: Record<CiProviderId, CiProviderMeta> = {
  github: {
    id: 'github',
    label: 'GitHub Actions',
    host: 'GitHub',
    workflowNoun: 'workflow',
    readsJobs: true,
    listsWorkflows: true,
  },
  'eas-workflows': {
    id: 'eas-workflows',
    label: 'EAS Workflows',
    host: 'Expo',
    workflowNoun: 'workflow',
    readsJobs: false,
    listsWorkflows: false,
  },
};

export const isCiProvider = (value: unknown): value is CiProviderId =>
  typeof value === 'string' && (CI_PROVIDERS as readonly string[]).indexOf(value) !== -1;

/** The provider of a run; runs stored before providers existed (or from an older server) are GitHub's. */
export const ciProviderOf = (value: unknown): CiProviderId =>
  isCiProvider(value) ? value : 'github';

/** The words for a run's provider. */
export const ciProviderMeta = (value: unknown): CiProviderMeta =>
  CI_PROVIDER_META[ciProviderOf(value)];
