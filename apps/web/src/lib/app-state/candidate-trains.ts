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
  create_release: ['done', 'done', 'waiting', 'todo', 'todo'],
  attach_build: ['done', 'waiting', 'current', 'todo', 'todo'],
  submit: ['done', 'done', 'done', 'waiting', 'todo'],
};

export function candidateTrain(plan: CandidatePlan, platform: Platform): Train {
  const c = plan.candidate;
  const version = c.version;
  const build = c.buildNumber;
  const stamp = c.processedAt ?? c.builtAt;
  const date = stamp === null ? '' : formatDate(stamp, { month: 'short', day: 'numeric' });
  const statuses = AT[plan.kind];
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
  if (plan.kind === 'create_release') {
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
  } else if (plan.kind === 'attach_build') {
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
    candidate: plan.kind,
  };
}
