import { sameVersion } from '@kiln/core';
import type { BuildEligibility, CodeEligibility } from './release-types.ts';

/**
 * Whether a build or a version code can be chosen for the draft release, as a machine reason and a plain sentence
 * (docs/api/releases-write.md, "Is this build eligible?"). Pure: it judges what the store listed and changes nothing.
 *
 * What is VERIFIED and what is not: Apple's pages name the build resource and its state, and say a build must be
 * processed before it can be used; they do not list the `processingState` values, the `expired` and
 * `usesNonExemptEncryption` attributes, or the rule that a build must belong to the version it is attached to. The rules
 * below follow how App Store Connect behaves and are UNVERIFIED; the store has the last word when the build is attached.
 */

export type BuildFacts = {
  buildNumber: string | null;
  /** The marketing version of the build. */
  version: string | null;
  /** Apple's `processingState`, upper case, or null. */
  processingState: string | null;
  expired: boolean | null;
  /** `answered`: Apple holds an export compliance answer; `missing`: the attribute came back empty; `unknown`: not returned. */
  exportCompliance: 'answered' | 'missing' | 'unknown';
  attached: boolean;
};

export type EditableFacts = { versionString: string | null } | null;

const label = (b: BuildFacts) => (b.buildNumber !== null ? `Build ${b.buildNumber}` : 'This build');

export function appleBuildEligibility(
  build: BuildFacts,
  editable: EditableFacts,
): BuildEligibility {
  const name = label(build);
  const blocked = (code: BuildEligibility['code'], message: string): BuildEligibility => ({
    eligible: false,
    severity: 'blocked',
    code,
    message,
  });
  if (build.expired === true)
    return blocked(
      'expired',
      `${name} has expired in App Store Connect and cannot be attached to a version.`,
    );
  switch (build.processingState) {
    case 'VALID':
      break;
    case 'PROCESSING':
      return blocked(
        'processing',
        `${name} is still being processed by Apple. It can be chosen when processing has finished.`,
      );
    case 'FAILED':
      return blocked('failed', `Apple could not process ${name}. Upload a new build.`);
    case 'INVALID':
      return blocked('invalid', `Apple marked ${name} as invalid. Upload a new build.`);
    default:
      return blocked(
        'state_unknown',
        `Apple did not say whether ${name} is processed, so it is not offered.`,
      );
  }
  if (editable === null) {
    return blocked(
      'no_editable_version',
      `${name} is processed, but there is no version in "Prepare for Submission" to attach it to. Create the next version in App Store Connect first.`,
    );
  }
  // The name of a version in App Store Connect is only a label that can no longer be changed once it
  // is made, and App Store Connect lets a build of another marketing version be attached. So a
  // difference is a warning to read, never a block (found by trying it on a real app).
  // `2.00.1` and `2.0.1` are one version (`sameVersion` of @kiln/core, the one comparison the web uses too).
  const mismatch =
    build.version !== null &&
    editable.versionString !== null &&
    !sameVersion(build.version, editable.versionString);
  if (build.attached) {
    return {
      eligible: false,
      severity: 'ok',
      code: 'already_attached',
      message: `${name} is already attached to version ${editable.versionString ?? 'being prepared'}.`,
    };
  }
  if (mismatch) {
    return {
      eligible: true,
      severity: 'warning',
      code: 'wrong_version',
      message: `${name} was built as version ${build.version}, and the version being prepared is named ${editable.versionString}. App Store Connect allows this; the name is only a label, and the app itself will still report ${build.version}.`,
    };
  }
  if (build.exportCompliance === 'missing') {
    return {
      eligible: true,
      severity: 'warning',
      code: 'export_compliance_missing',
      message: `${name} can be chosen, but Apple holds no export compliance answer for it yet; App Store Connect may ask for one before the version can be submitted.`,
    };
  }
  return {
    eligible: true,
    severity: 'ok',
    code: 'ok',
    message: `${name} is processed and can be attached to version ${editable.versionString ?? 'being prepared'}.`,
  };
}

export type CodeFacts = {
  versionCode: string;
  inTrack: { name: string | null; status: string }[];
};

/** Google Play: a version code can be put into a draft release unless the track already holds it in a draft or a live release. */
export function playCodeEligibility(code: CodeFacts): CodeEligibility {
  const live = code.inTrack.find((r) => r.status === 'completed' || r.status === 'inProgress');
  if (live) {
    return {
      eligible: false,
      severity: 'blocked',
      code: 'already_live',
      message: `Version code ${code.versionCode} is already in a release of this track that is ${live.status === 'completed' ? 'live' : 'rolling out'}.`,
    };
  }
  const draft = code.inTrack.find((r) => r.status === 'draft');
  if (draft) {
    return {
      eligible: false,
      severity: 'ok',
      code: 'already_in_draft',
      message: `Version code ${code.versionCode} is already in the draft release of this track.`,
    };
  }
  return {
    eligible: true,
    severity: 'ok',
    code: 'ok',
    message: `Version code ${code.versionCode} was uploaded and is not in a release of this track yet.`,
  };
}
