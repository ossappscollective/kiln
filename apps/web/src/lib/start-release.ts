import { type Platform, platformLabel } from '@mrm/core';
import { releaseStepHref } from './release-stepper.ts';
import { canDispatchWorkflow } from './ci.ts';
import type { ActiveRun, AppBuild, CiWorkflow, WorkflowInputSpec } from './types.ts';
import type { WorkflowEntry } from './workflows.ts';

/**
 * "Start release": the button on the app dashboard and the releases tab that opens the dispatch dialog
 * already filled in where we know the answer, follows the run it started and offers "Prepare release"
 * when a matching build shows up. Pure helpers only; the screen is components/app/StartRelease.svelte.
 * The dispatch itself is the existing one (`POST .../workflows/<workflow>/dispatches`): nothing here
 * starts anything, and nothing here talks to a store.
 */

// ---------------------------------------------------------------------------------------------
// Which workflow

export type ChosenWorkflow = { workflow: CiWorkflow; why: 'configured' | 'release' };

/**
 * The workflow to start: the release workflow of the app's build conventions; else the one workflow
 * whose name says release, publish or deploy for the platforms in scope. Never a guess between several,
 * and never one GitHub has disabled. Null means the person must pick one on the Workflows page.
 */
export function chooseReleaseWorkflow(entries: readonly WorkflowEntry[], platforms: readonly Platform[]): ChosenWorkflow | null {
  const usable = entries.filter((e) => canDispatchWorkflow(e.workflow));
  const configured = usable.filter((e) => e.relevance === 'configured');
  if (configured.length === 1) return { workflow: (configured[0] as WorkflowEntry).workflow, why: 'configured' };
  if (configured.length > 1) return null;
  const forScope = (e: WorkflowEntry) => e.platforms.length === 0 || e.platforms.some((p) => platforms.includes(p));
  const named = usable.filter((e) => e.relevance === 'release' && forScope(e));
  // Several release workflows: prefer the ones that name the platform in scope, and only when that leaves one.
  const exact = named.filter((e) => e.platforms.length > 0);
  const pool = named.length === 1 ? named : exact.length === 1 ? exact : [];
  return pool.length === 1 ? { workflow: (pool[0] as WorkflowEntry).workflow, why: 'release' } : null;
}

// ---------------------------------------------------------------------------------------------
// Prefilled inputs

export type DispatchHint = {
  /** The platforms in scope of the app page. */
  platforms: readonly Platform[];
  /** The version selected in the page header, when one is. */
  version?: string | null;
};

const PLATFORM_INPUTS = ['platform', 'platforms', 'os', 'target', 'store'];
const VERSION_INPUTS = ['version', 'app_version', 'release_version', 'marketing_version'];

const WORDS: Record<Platform, string[]> = {
  ios: ['ios', 'iphone', 'apple', 'app store', 'testflight'],
  macos: ['macos', 'mac', 'osx'],
  android: ['android', 'google play', 'play'],
};

const simple = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function platformChoice(spec: WorkflowInputSpec, platforms: readonly Platform[]): string | null {
  const options = spec.options ?? [];
  if (platforms.length === 1) {
    const platform = platforms[0] as Platform;
    const hit = options.find((o) => WORDS[platform].indexOf(simple(o)) >= 0);
    if (hit !== undefined) return hit;
    if (spec.type !== 'choice') return platform;
    return null;
  }
  const both = options.find((o) => ['both', 'all', 'all platforms'].indexOf(simple(o)) >= 0);
  return both ?? null;
}

/**
 * Values for the inputs of the workflow that the page already knows: a platform input gets the platform
 * in scope (a choice only when one of its options says so), a version input the selected version. Only
 * inputs that exist and are still empty or at their default are touched by the caller; this returns
 * what to suggest and never an unknown name.
 */
export function dispatchHints(specs: readonly WorkflowInputSpec[], hint: DispatchHint): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const name = spec.name.toLowerCase();
    if (PLATFORM_INPUTS.indexOf(name) >= 0 && hint.platforms.length > 0) {
      const value = platformChoice(spec, hint.platforms);
      if (value !== null) out[spec.name] = value;
    } else if (VERSION_INPUTS.indexOf(name) >= 0 && hint.version && spec.type !== 'boolean' && spec.type !== 'choice') {
      out[spec.name] = hint.version;
    }
  }
  return out;
}

/** The sentence under the button that says what was filled in, or '' when nothing was. */
export function prefillNote(chosen: ChosenWorkflow, hint: DispatchHint): string {
  const where = chosen.why === 'configured' ? 'the release workflow of this app' : 'the only release workflow found';
  const scope = hint.platforms.length === 1 ? ` for ${platformLabel(hint.platforms[0] as Platform)}` : '';
  return `${chosen.workflow.name}: ${where}${scope}.`;
}

// ---------------------------------------------------------------------------------------------
// The started run, and the build it makes

export type StartedRun = {
  repositoryId: string;
  runId: string;
  workflow: string;
  startedAt: number;
  platforms: Platform[];
};

/**
 * Whether a run from the feed is the one that was started here. A dispatch whose run GitHub has not named
 * yet is stored as `pending-...`; such a run is found again by its repository and workflow, started a
 * little before or after the dispatch (clocks differ).
 */
export function isStartedRun(
  run: Pick<ActiveRun, 'repositoryId' | 'id' | 'workflow' | 'startedAt'>,
  started: Pick<StartedRun, 'repositoryId' | 'runId' | 'workflow' | 'startedAt'>,
): boolean {
  if (run.repositoryId !== started.repositoryId) return false;
  if (run.id === started.runId) return true;
  return started.runId.indexOf('pending') === 0 && run.workflow === started.workflow && run.startedAt >= started.startedAt - 60_000;
}

/**
 * The builds that this run (or, failing that, a run that started after it) produced: the build is linked
 * to the run, or it was uploaded to the store after the run started. Newest first. A build the platforms
 * in scope do not include is ignored.
 */
export function matchingBuilds(
  builds: readonly AppBuild[],
  started: Pick<StartedRun, 'runId' | 'startedAt' | 'platforms'>,
): AppBuild[] {
  return builds
    .filter((b) => started.platforms.length === 0 || started.platforms.indexOf(b.platform) >= 0)
    .filter((b) => b.link?.run?.id === started.runId || (b.uploadedAt !== null && b.uploadedAt >= started.startedAt))
    .sort((a, b) => (b.uploadedAt ?? b.syncedAt) - (a.uploadedAt ?? a.syncedAt));
}

/** Where "Prepare release" goes for a build: the Build step of the stepper on the releases tab, with its version selected. */
export function prepareReleaseHref(appId: string, build: Pick<AppBuild, 'platform' | 'version'>, scopeIsBoth: boolean): string {
  return releaseStepHref(appId, scopeIsBoth ? 'both' : build.platform, 'build', build.version);
}

/** The line shown with the started run, by what is known about it. */
export function startedLine(input: {
  workflow: string;
  running: boolean;
  build: Pick<AppBuild, 'buildNumber' | 'version'> | null;
  failed?: boolean;
}): string {
  if (input.failed) return `${input.workflow} did not succeed, so no build is expected from it.`;
  if (input.build) return `Build ${input.build.buildNumber} (version ${input.build.version}) is ready.`;
  return input.running ? `${input.workflow} was started. Waiting for it to produce a build.` : `${input.workflow} has finished. No new build was found yet.`;
}
