import type { PipelineStepRow, PipelineStepStatus, Platform } from '@kiln/core';
import { formatDate } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import { statusWord, stripLabel, waitingOf } from '../release-pipeline.ts';
import type { Train } from '../release-trains.ts';
import type { CandidatePlan } from './candidates.ts';

/**
 * A release candidate as a release train (docs/state-model.md): the next step a newer build asks for, worded, with its button, in the shape
 * the release flow already draws (a card, a row per platform, the five steps). Internal to the model: `deriveAppState` puts these beside
 * the trains of the release pipeline, so the iOS "Create release 2.0.1 from TestFlight build 95" is a step of the same flow as Android's
 * "Promote to production", never a second flow.
 */

const STEP_IDS: readonly PipelineStepRow['id'][] = ['ci', 'build', 'prepare', 'review', 'release'];

/** The five steps for each plan: the build exists; what is left is making a version, putting the build in it, or sending it. */
const AT: Readonly<Record<CandidatePlan['kind'], readonly PipelineStepStatus[]>> = {
  // The store would refuse to create the version: the build waits, and the line says why (never a button that leads to the refusal).
  blocked: ['done', 'done', 'waiting', 'todo', 'todo'],
  create_release: ['done', 'done', 'waiting', 'todo', 'todo'],
  attach_build: ['done', 'waiting', 'current', 'todo', 'todo'],
  submit: ['done', 'done', 'done', 'waiting', 'todo'],
};

/** The sentence for the first refusal of a create (`createReleaseRules` of @kiln/core), with the words of this screen. */
function refusalLine(plan: Extract<CandidatePlan, { kind: 'blocked' }>): string {
  const { version, buildNumber: build } = plan.candidate;
  switch (plan.refusal[0]) {
    case 'editable_version_exists':
      return t('state:candidate.blocked.editable', {
        editable: plan.editableVersion ?? '',
        version,
        build,
      });
    case 'version_exists':
      return t('state:candidate.blocked.exists', { version });
    case 'not_higher':
      return t('state:candidate.blocked.notHigher', { version, newest: plan.newestFixed ?? '' });
    default:
      return t('state:candidate.blocked.invalid', { version });
  }
}

export function candidateTrain(plan: CandidatePlan, platform: Platform): Train {
  const c = plan.candidate;
  const build = c.buildNumber;
  // A refused create whose way out is an editable version that is NOT left behind: the right action is to attach the build THERE.
  const attachHere =
    plan.kind === 'blocked' &&
    plan.refusal[0] === 'editable_version_exists' &&
    plan.editableVersion !== null &&
    !plan.editableObsolete;
  const version = plan.kind === 'blocked' && attachHere ? (plan.editableVersion ?? c.version) : c.version;
  const stamp = c.processedAt ?? c.builtAt;
  const date = stamp === null ? '' : formatDate(stamp, { month: 'short', day: 'numeric' });
  const kind: CandidatePlan['kind'] = attachHere ? 'attach_build' : plan.kind;
  const statuses = AT[kind];
  const steps = STEP_IDS.map((id, i) => {
    const status = statuses[i] as PipelineStepStatus;
    return {
      id,
      label: stripLabel(id),
      status,
      word: statusWord(status),
      detail: null,
      current: status === 'waiting' || status === 'current',
    };
  });
  let title: string;
  let line: string;
  let button: Train['button'];
  if (plan.kind === 'blocked' && !attachHere) {
    title = t('state:candidate.blocked.title', { version: c.version, build });
    line = refusalLine(plan);
    // The way out is in the store (a version left behind, a name that is taken): a link there, never a button that ends in a refusal.
    button = { label: t('state:candidate.blocked.action'), appId: c.appId, step: 'build', review: true };
  } else if (kind === 'create_release') {
    title = t('state:candidate.create.title', { version, build });
    line =
      date === ''
        ? t('state:candidate.create.textNoDate', { version, build })
        : t('state:candidate.create.text', { version, build, date });
    button = {
      label: t('state:candidate.create.action', { version }),
      appId: c.appId,
      step: 'build',
      action: 'create_release',
      build,
    };
  } else if (kind === 'attach_build') {
    title = t('state:candidate.attach.title', { version, build });
    line = t('state:candidate.attach.text', { version, build });
    button = {
      label: t('release:train.attachBuild', { number: build }),
      appId: c.appId,
      step: 'build',
    };
  } else {
    title = t('state:candidate.submit.title', { version });
    line = t('state:candidate.submit.text', { version, build });
    button = {
      label: t('state:candidate.submit.title', { version }),
      appId: c.appId,
      step: 'confirm',
    };
  }
  return {
    key: `${platform}:candidate:${version}`,
    version,
    platforms: [platform],
    appIds: [c.appId],
    title,
    steps,
    waiting: waitingOf('you'),
    lines: [line],
    button,
    candidate: kind,
  };
}
