import { randomUUID } from 'node:crypto';
import type { DraftFieldState, DraftFieldWrite } from '@mrm/connectors';
import { byFamily, type StagedChangesView } from '@mrm/core';
import {
  checkReleaseField,
  isReleaseFieldId,
  isStageableReleaseField,
  normalizeReleaseValue,
  type Platform,
  RELEASE_FIELD_SPECS,
  type ReleaseValueInput,
  STAGEABLE_RELEASE_FIELDS,
  STAGED_LIMITS,
} from '@mrm/core';
import { getApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { hashListingValue } from '../modules/listing/drift.ts';
import { type Failure, failure } from './repositories.ts';
import { buildStagedView, isStageableLocale, type StagedContext } from './staged-changes.ts';

/**
 * Staging the release fields of a DRAFT release (docs/api/releases-write.md, docs/adr/0014-release-management.md): the App
 * Store version's build, version string, release type, earliest release date, copyright and phased release, or the Google Play
 * draft release's track, name, version codes and per language release notes. Staging reads and writes the database only; the
 * values reach a store only through the draft push (services/store-draft.ts), which is switched off by default.
 *
 * - One row per field (and language), `kind = 'release_field'`, `target = the field id`, `locale` empty except for Play release notes.
 *   `source` is `local`: a release field has no repository or store snapshot to take it from.
 * - Values are normalized (`normalizeReleaseValue`) so what is previewed is what is pushed, and checked on their own
 *   (`checkReleaseField`). What the store holds is checked by the push preview.
 * - Audited with ids and a hash: the value is never put in an audit entry.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type StageReleaseFieldInput = {
  workspaceId: string;
  appId: string;
  field: string;
  /** The language of a per language field (Play release notes). Empty or absent otherwise. */
  locale?: string | undefined;
  value: ReleaseValueInput;
  actor: Actor;
};

const invalid = (code: string, message: string, extra: Record<string, unknown> = {}): Failure =>
  failure(422, code, message, extra);

export async function stageReleaseField(
  ctx: StagedContext,
  input: StageReleaseFieldInput,
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!isReleaseFieldId(input.field) || !isStageableReleaseField(app.platform, input.field)) {
    const store = byFamily(app.platform, { apple: 'an App Store', google: 'a Google Play' });
    return invalid(
      'field_not_stageable',
      isReleaseFieldId(input.field)
        ? `${RELEASE_FIELD_SPECS[input.field].label} cannot be staged for ${store} app.`
        : 'Not a release field.',
      { field: 'field', allowed: STAGEABLE_RELEASE_FIELDS[app.platform] },
    );
  }
  const field = input.field;
  const spec = RELEASE_FIELD_SPECS[field];
  const locale = input.locale ?? '';
  if (spec.perLocale) {
    if (locale === '' || !isStageableLocale(locale))
      return invalid('invalid_locale', 'locale must be a store language code such as en-US.', {
        field: 'locale',
      });
  } else if (locale !== '') {
    return invalid('invalid_locale', `${spec.label} has no language: leave locale out.`, {
      field: 'locale',
    });
  }
  const value = normalizeReleaseValue(field, input.value);
  if (value === '')
    return invalid(
      'empty_value',
      'An empty value is not staged: this server does not clear a store field. Remove the item instead.',
      { field: 'value' },
    );
  if (value.length > STAGED_LIMITS.maxTextChars) {
    return invalid(
      'text_too_long',
      `A staged value is at most ${STAGED_LIMITS.maxTextChars} characters.`,
      { field: 'value', limit: STAGED_LIMITS.maxTextChars, actual: value.length },
    );
  }
  const at = ctx.now();
  const errors = checkReleaseField(app.platform, field, locale, value, at).filter(
    (p) => p.severity === 'error',
  );
  if (errors[0])
    return invalid('invalid_staged', errors[0].message, { field: 'value', code: errors[0].code });
  const hash = hashListingValue(value);
  const refused = await db.transaction(async (tx) => {
    const [existing] = await tx.query(
      "SELECT id FROM staged_changes WHERE app_id = ? AND kind = 'release_field' AND locale = ? AND target = ? AND ordinal = 0",
      [app.id, locale, field],
    );
    if (existing) {
      await tx.execute(
        "UPDATE staged_changes SET source = 'local', value_text = ?, value_hash = ?, updated_at = ? WHERE id = ?",
        [value, hash, at, String(existing.id)],
      );
    } else {
      const [count] = await tx.query(
        'SELECT COUNT(*) AS n FROM staged_changes WHERE workspace_id = ? AND app_id = ?',
        [input.workspaceId, app.id],
      );
      if (Number(count?.n ?? 0) >= STAGED_LIMITS.maxItems) {
        return invalid(
          'too_many_items',
          `At most ${STAGED_LIMITS.maxItems} items can be staged for an app.`,
          { limit: STAGED_LIMITS.maxItems },
        );
      }
      await tx.execute(
        `INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'release_field', ?, ?, 0, 'local', ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          app.id,
          app.platform,
          locale,
          field,
          value,
          hash,
          input.actor.id,
          at,
          at,
        ],
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'staged.release_field_set',
      target: { type: 'app', id: app.id },
      // Ids and a hash: never the value (release notes are copy; the others are ids and dates that need no copy here).
      detail: {
        appId: app.id,
        platform: app.platform,
        field,
        ...(locale !== '' ? { locale } : {}),
        valueHash: hash,
        chars: value.length,
      },
      at,
    });
    return undefined;
  });
  if (refused) return refused;
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

// ---------------------------------------------------------------------------------------------
// What the store says about the staged fields

export type ReleaseCheck = {
  code: string;
  /** `blocking`: the push is refused until it is fixed. `warning`: shown, does not stop it. */
  severity: 'blocking' | 'warning';
  message: string;
  field?: string;
  locale?: string;
};

const MAX_CODES_SHOWN = 10;

/**
 * Checks of the staged release fields against what the store says (the facts the connector reads next to each field). Pure.
 * Blocking: something the store would certainly refuse or that cannot be what the person means. Warnings never stop a push.
 */
export function releaseFieldChecks(input: {
  platform: Platform;
  fields: readonly DraftFieldWrite[];
  state: readonly DraftFieldState[] | undefined;
}): ReleaseCheck[] {
  const out: ReleaseCheck[] = [];
  if (input.fields.length === 0) return out;
  const add = (check: ReleaseCheck) => out.push(check);
  if (input.state === undefined) {
    add({
      code: 'release_fields_unreadable',
      severity: 'blocking',
      message: 'The release fields in the store could not be read, so they cannot be compared.',
    });
    return out;
  }
  const stateOf = (field: string, locale: string) =>
    input.state?.find((s) => s.field === field && s.locale === locale);
  for (const w of input.fields) {
    const label =
      RELEASE_FIELD_SPECS[isReleaseFieldId(w.field) ? w.field : 'build']?.label ?? w.field;
    const found = stateOf(w.field, w.locale);
    if (!found) {
      add({
        code: 'field_unreadable',
        severity: 'blocking',
        message: `${label} could not be read from the store.`,
        field: w.field,
        ...(w.locale !== '' ? { locale: w.locale } : {}),
      });
      continue;
    }
    const facts = found.facts ?? {};
    if (w.field === 'build') {
      if (facts.wantedFound === false) {
        add({
          code: 'build_not_found',
          severity: 'blocking',
          message:
            'No build with this id belongs to this app on this platform. Choose one from the builds list.',
          field: 'build',
        });
      } else {
        if (facts.wantedExpired === true)
          add({
            code: 'build_expired',
            severity: 'blocking',
            message: `Build ${facts.wantedNumber ?? w.value} has expired and cannot be attached.`,
            field: 'build',
          });
        const processing = facts.wantedProcessingState;
        if (typeof processing === 'string' && processing !== 'VALID') {
          add({
            code: 'build_not_processed',
            severity: 'blocking',
            message: `Build ${facts.wantedNumber ?? w.value} is not ready (${processing}). Wait until it is processed.`,
            field: 'build',
          });
        }
      }
    } else if (w.field === 'version_codes') {
      const missing =
        typeof facts.missing === 'string' && facts.missing !== '' ? facts.missing.split(',') : [];
      if (missing.length > 0) {
        add({
          code: 'version_codes_not_uploaded',
          severity: 'blocking',
          message: `Google Play does not list ${missing.length === 1 ? 'this version code' : 'these version codes'} as uploaded: ${missing.slice(0, MAX_CODES_SHOWN).join(', ')}${missing.length > MAX_CODES_SHOWN ? ', ...' : ''}.`,
          field: 'version_codes',
        });
      }
    } else if (w.field === 'track') {
      const hasCodes = input.fields.some((f) => f.field === 'version_codes');
      if (facts.draftCount === 0 && !hasCodes) {
        add({
          code: 'no_draft_release',
          severity: 'blocking',
          message: `The ${w.value} track has no draft release. Stage the version codes to create one.`,
          field: 'track',
        });
      } else if (facts.draftCount === 0) {
        add({
          code: 'new_draft_release',
          severity: 'warning',
          message: `The ${w.value} track has no draft release: the push creates one.`,
          field: 'track',
        });
      }
      if (typeof facts.otherInProgress === 'number' && facts.otherInProgress > 0) {
        add({
          code: 'rollout_in_progress',
          severity: 'warning',
          message: `The ${w.value} track has a release that is rolling out. The draft is written beside it; starting this draft later is a separate, gated step.`,
          field: 'track',
        });
      }
    } else if (
      w.field === 'release_type' &&
      w.value === 'SCHEDULED' &&
      !input.fields.some((f) => f.field === 'earliest_release_date')
    ) {
      add({
        code: 'scheduled_needs_date',
        severity: 'warning',
        message:
          'SCHEDULED needs an earliest release date. Apple refuses it when the version has none (UNVERIFIED: the store decides).',
        field: 'release_type',
      });
    }
  }
  return out;
}
