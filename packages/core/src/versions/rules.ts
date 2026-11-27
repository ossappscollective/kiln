import type { ReleaseFact } from './live.ts';
import { isCreatableVersion, tryCompareVersions } from './compare.ts';

/**
 * "May this version be created?": the SERVER's refusals, as one pure function the client asks BEFORE it offers a button
 * (docs/state-model.md, "Single owners (core)"). The server (`evaluateChecks` of publish/store-version.ts) refuses to create an
 * App Store version when
 *  - the string is not one to three whole numbers (`invalid_version`: `2.0.1.90`, `v2.0`, `2.0-beta`),
 *  - an EDITABLE version already exists (`editable_version_exists`: attach the build to it instead; no connector can delete a version),
 *  - the version already exists in any state (`version_exists`),
 *  - it is not higher than the newest NON-EDITABLE version (`not_higher`: in review, approved, processing and live all count).
 * The client used to plan "Create release 2.0.1" without asking any of it, so the button led to a refusal.
 *
 * `not_higher` is judged against the newest non-editable version, which can be HIGHER than what is live (a version in review): it is not
 * the same bar as "newer than live" of the candidate model, and the candidate model now asks this function as well.
 *
 * Pure. ES2017.
 */

export type CreateRefusal = 'invalid_version' | 'editable_version_exists' | 'version_exists' | 'not_higher';

/** One version the store lists, as the rule reads it. `editable`: it can still be edited, so it is the one to use. */
export type StoreVersionFact = { version: string | null; editable: boolean };

export type CreateReleaseCheck =
  | { ok: true }
  | {
      ok: false;
      /** The first refusal, in the order of the list above. */
      reason: CreateRefusal;
      /** Every refusal that applies. */
      reasons: CreateRefusal[];
      /** The editable version that is in the way (`editable_version_exists`). */
      editableVersion?: string | null;
      /** The version the new one has to be higher than (`not_higher`). */
      newestFixed?: string | null;
    };

/** The newest version that cannot be edited: the bar a new version has to clear. Unreadable versions are ignored. */
export function newestNonEditableVersion(versions: readonly StoreVersionFact[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (v.editable || v.version === null || !isCreatableVersion(v.version)) continue;
    if (best === null || (tryCompareVersions(v.version, best) ?? 0) > 0) best = v.version;
  }
  return best;
}

/**
 * The store's versions from the releases a client holds. A release is EDITABLE while it is in preparation (draft, build chosen, ready)
 * or rejected (Apple lets a rejected version be edited and resubmitted). APPROXIMATION: Apple also lists a version waiting for review
 * as editable; the normalized status cannot tell, so the server's own read stays the authority and this is only used to decide whether
 * to OFFER the action.
 */
export function storeVersionsOf(releases: readonly Pick<ReleaseFact, 'version' | 'status'>[]): StoreVersionFact[] {
  return releases.map((r) => ({
    version: r.version,
    editable:
      r.status === 'draft' || r.status === 'build_chosen' || r.status === 'ready' || r.status === 'rejected',
  }));
}

/**
 * The server's checks for creating `version` next to these store versions. `{ ok: true }` or the reasons it is refused. The same
 * `version_in_progress` warning of the server (another version is in review) is not a refusal and is not returned here.
 */
export function createReleaseRules(
  version: string,
  versions: readonly StoreVersionFact[],
): CreateReleaseCheck {
  const reasons: CreateRefusal[] = [];
  const creatable = isCreatableVersion(version);
  if (!creatable) reasons.push('invalid_version');
  const editable = versions.filter((v) => v.editable)[0] ?? null;
  if (editable !== null) reasons.push('editable_version_exists');
  let newestFixed: string | null = null;
  if (creatable) {
    const exists = versions.some(
      (v) => v.version !== null && isCreatableVersion(v.version) && tryCompareVersions(v.version, version) === 0,
    );
    if (exists) reasons.push('version_exists');
    else {
      newestFixed = newestNonEditableVersion(versions);
      if (newestFixed !== null && (tryCompareVersions(version, newestFixed) ?? 1) <= 0)
        reasons.push('not_higher');
    }
  }
  if (reasons.length === 0) return { ok: true };
  return {
    ok: false,
    reason: reasons[0] as CreateRefusal,
    reasons,
    ...(editable !== null ? { editableVersion: editable.version } : {}),
    ...(reasons.indexOf('not_higher') >= 0 ? { newestFixed } : {}),
  };
}
