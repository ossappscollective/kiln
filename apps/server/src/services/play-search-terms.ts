import { createHash } from 'node:crypto';
import {
  AnalyticsError,
  checkPeriod,
  readSearchTermsFile,
  type SearchTermsFile,
} from '@kiln/connectors';
import {
  type ActorType,
  addDays,
  analyticsErrorMessages,
  daysBetween,
  type FitFields,
  isIsoDate,
  isSearchTermSort,
  normalizeCountry,
  PLAY_SEARCH_TERMS_SUMMARY_LIMIT,
  type SearchTermInsight,
  type SearchTermPoint,
  type SearchTermSort,
  type SearchTermsSummary,
  searchTermInsights,
  searchTermLimits,
  summariseSearchTerms,
  supports,
} from '@kiln/core';
import { type Database, nullableNumber, type Param, type Sql } from '@kiln/db';
import { coded } from '../i18n/problem.ts';
import { defaultLocale, ownFields } from '../modules/aso/insights.ts';
import { listKeywords } from '../modules/aso/service.ts';
import type { ManagedApp } from './apps.ts';
import { getApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { type Failure, failure } from './repositories.ts';

/**
 * Google Play search terms (docs/research/play-search-terms.md, docs/api/aso.md): a file the developer exports from Play Console is
 * imported into `play_search_terms` (preview, then confirm by hash), and read back as the top terms of a period with which are tracked
 * and which are in the stored listing text.
 *
 * - Needs `analytics.manage` to import; reading needs `aso.read`. Works whether or not `analytics.enabled` is on: it contacts no store.
 * - Strict: the size, the unpacked size, the entries, the rows are capped; columns are matched by name (connectors `readSearchTermsFile`);
 *   a failure is a code of the analytics vocabulary.
 * - Idempotent: the same file twice writes nothing (`written: 0`); a corrected file replaces a row with the same app, country, period and term.
 * - PRIVACY: a term is data in the table `play_search_terms` and in the answers of the two routes for this app. It is never written to a log,
 *   an audit row, an event, a job payload, an error message or a note: those carry counts and codes.
 */

type Actor = { type: ActorType; id: string };

export type SearchTermsPlan = {
  platform: 'android';
  report: { kind: 'play_search_terms'; label: string };
  stats: SearchTermsFile['stats'];
  dateFrom: string | null;
  dateTo: string | null;
  /** The file had its own dates. When false, `period` is the one the person gave. */
  hasDates: boolean;
  period: { from: string; to: string } | null;
  /** Days from the first to the last date. */
  days: number;
  /** Rows that would be stored. */
  rows: number;
  /** Terms without the `Other` line. */
  terms: number;
  countries: string[];
  files: number;
  totals: { visitors: number | null; installs: number | null };
  other: { visitors: number | null; installs: number | null } | null;
  /** The ten terms with most installs, so the person sees what is in the file. */
  top: {
    term: string;
    visitors: number | null;
    installs: number | null;
    conversion: number | null;
  }[];
  /** Different stored periods of the same country that overlap the file and could count a day twice (a period file is one side of it). */
  overlapsStored: number;
  notes: string[];
};

const hashOf = (appId: string, points: readonly SearchTermPoint[]): string => {
  const rows = points
    .map(
      (p) =>
        [p.country, p.from, p.to, p.key, p.term, p.visitors, p.installs, p.conversion] as const,
    )
    .sort((a, b) =>
      `${a[0]}|${a[1]}|${a[2]}|${a[3]}` < `${b[0]}|${b[1]}|${b[2]}|${b[3]}` ? -1 : 1,
    );
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, appId, rows }))
    .digest('hex');
};

const toMicro = (r: number | null) => (r === null ? null : Math.round(r * 1_000_000));

type Parsed =
  | {
      ok: true;
      plan: SearchTermsPlan;
      points: SearchTermPoint[];
      confirmHash: string;
      app: ManagedApp;
    }
  | Failure;

type Input = { workspaceId: string; appId: string; bytes: Uint8Array; from?: string; to?: string };

async function overlaps(
  sql: Sql,
  workspaceId: string,
  appId: string,
  file: SearchTermsFile,
): Promise<number> {
  if (file.dateFrom === null || file.dateTo === null) return 0;
  const stored = await sql.query(
    `SELECT DISTINCT country, period_from, period_to FROM play_search_terms
      WHERE workspace_id = ? AND app_id = ? AND period_to >= ? AND period_from <= ? LIMIT 500`,
    [workspaceId, appId, file.dateFrom, file.dateTo],
  );
  const mine = new Map<string, { country: string; from: string; to: string }>();
  for (const p of file.points)
    mine.set(`${p.country}|${p.from}|${p.to}`, { country: p.country, from: p.from, to: p.to });
  let count = 0;
  for (const r of stored) {
    const c = { country: String(r.country), from: String(r.period_from), to: String(r.period_to) };
    if (mine.has(`${c.country}|${c.from}|${c.to}`)) continue;
    for (const f of mine.values()) {
      if (
        f.country === c.country &&
        c.from <= f.to &&
        f.from <= c.to &&
        (c.from !== c.to || f.from !== f.to)
      ) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/** Parses a file for an app. Pure with respect to storage: nothing is written. */
export async function parseSearchTermsImport(db: Database, input: Input): Promise<Parsed> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'searchTermsImport')) {
    return failure(
      422,
      'import_not_supported',
      'Search terms are a Google Play report. This app is an iOS or macOS app.',
      coded('aso.playOnly'),
    );
  }
  if ((input.from !== undefined || input.to !== undefined) && !checkPeriod(input.from, input.to)) {
    return failure(422, 'period_required', analyticsErrorMessages.period_required);
  }
  try {
    const file = await readSearchTermsFile(input.bytes, {
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    });
    const period = checkPeriod(input.from, input.to) ?? null;
    const from = file.dateFrom as string;
    const to = file.dateTo as string;
    const summary = summariseSearchTerms(file.points, {
      from,
      to,
      limit: PLAY_SEARCH_TERMS_SUMMARY_LIMIT,
    });
    const notes = [...file.notes];
    const overlapsStored = await overlaps(db, input.workspaceId, app.id, file);
    if (overlapsStored > 0) {
      notes.push(
        'Numbers already stored for this app overlap these dates and are not the same periods. Where a day appears in both, only the day rows are counted, so a day is not counted twice, but check that the periods are what you expect.',
      );
    }
    const plan: SearchTermsPlan = {
      platform: 'android',
      report: { kind: 'play_search_terms', label: 'Google Play search terms' },
      stats: file.stats,
      dateFrom: file.dateFrom,
      dateTo: file.dateTo,
      hasDates: file.hasDates,
      period: file.hasDates ? null : period,
      days: daysBetween(from, to) + 1,
      rows: file.points.length,
      terms: file.terms,
      countries: file.countries,
      files: file.files,
      totals: summary.totals,
      other: summary.other,
      top: summary.terms.map((t) => ({
        term: t.term,
        visitors: t.visitors,
        installs: t.installs,
        conversion: t.conversion,
      })),
      overlapsStored,
      notes,
    };
    return { ok: true, plan, points: file.points, confirmHash: hashOf(app.id, file.points), app };
  } catch (error) {
    if (error instanceof AnalyticsError) return failure(422, error.code, error.message);
    return failure(422, 'bad_format', analyticsErrorMessages.bad_format);
  }
}

export async function previewSearchTermsImport(
  db: Database,
  input: Input,
): Promise<{ ok: true; plan: SearchTermsPlan; confirmHash: string } | Failure> {
  const parsed = await parseSearchTermsImport(db, input);
  if (!parsed.ok) return parsed;
  return { ok: true, plan: parsed.plan, confirmHash: parsed.confirmHash };
}

export type SearchTermsImportResult = {
  ok: true;
  rows: number;
  /** Rows inserted or changed. */
  written: number;
  /** Rows that already held these numbers. */
  unchanged: number;
  dateFrom: string | null;
  dateTo: string | null;
};

const CHUNK = 100;
const differs = (c: string) =>
  `(play_search_terms.${c} <> excluded.${c} OR (play_search_terms.${c} IS NULL AND excluded.${c} IS NOT NULL) OR (play_search_terms.${c} IS NOT NULL AND excluded.${c} IS NULL))`;

/** Writes the rows by key. A row is changed only when a number or the spelling differs, so a repeat writes nothing. */
export async function upsertSearchTerms(
  sql: Sql,
  input: { workspaceId: string; appId: string; now: number },
  points: readonly SearchTermPoint[],
): Promise<{ offered: number; written: number }> {
  let written = 0;
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    const params: Param[] = [];
    for (const p of chunk) {
      params.push(
        input.appId,
        p.country,
        p.from,
        p.to,
        p.key,
        input.workspaceId,
        p.term,
        p.visitors,
        p.installs,
        toMicro(p.conversion),
        input.now,
      );
    }
    written += await sql.execute(
      `INSERT INTO play_search_terms
         (app_id, country, period_from, period_to, term_key, workspace_id, term, visitors, installs, conversion_micro, imported_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (app_id, country, period_from, period_to, term_key) DO UPDATE SET
         term = excluded.term, visitors = excluded.visitors, installs = excluded.installs,
         conversion_micro = excluded.conversion_micro, imported_at = excluded.imported_at
       WHERE ${['term', 'visitors', 'installs', 'conversion_micro'].map(differs).join(' OR ')}`,
      params,
    );
  }
  return { offered: points.length, written };
}

export async function applySearchTermsImport(
  db: Database,
  now: () => number,
  input: Input & { confirmHash: string },
  actor: Actor,
): Promise<SearchTermsImportResult | Failure> {
  const parsed = await parseSearchTermsImport(db, input);
  if (!parsed.ok) return parsed;
  if (parsed.confirmHash !== input.confirmHash) {
    const message = 'The file is not the one that was previewed. Preview it again and confirm.';
    return {
      ...failure(409, 'confirm_mismatch', message),
      body: { error: 'confirm_mismatch', message },
    };
  }
  const app = parsed.app;
  const at = now();
  return db.transaction(async (tx): Promise<SearchTermsImportResult | Failure> => {
    const result = await upsertSearchTerms(
      tx,
      { workspaceId: input.workspaceId, appId: app.id, now: at },
      parsed.points,
    );
    await tx.execute(
      `INSERT INTO play_search_term_imports (app_id, workspace_id, last_import_at, last_period_from, last_period_to, imports, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (app_id) DO UPDATE SET last_import_at = excluded.last_import_at, last_period_from = excluded.last_period_from,
         last_period_to = excluded.last_period_to, imports = play_search_term_imports.imports + 1, updated_by = excluded.updated_by`,
      [app.id, input.workspaceId, at, parsed.plan.dateFrom, parsed.plan.dateTo, actor.id],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'analytics.search_terms_import',
      target: { type: 'app', id: app.id },
      // Ids and counts: never a term, never a row, never the file name.
      detail: {
        rows: result.offered,
        written: result.written,
        terms: parsed.plan.terms,
        countries: parsed.plan.countries.length,
        files: parsed.plan.files,
        dateFrom: parsed.plan.dateFrom,
        dateTo: parsed.plan.dateTo,
      },
      at,
    });
    return {
      ok: true,
      rows: result.offered,
      written: result.written,
      unchanged: result.offered - result.written,
      dateFrom: parsed.plan.dateFrom,
      dateTo: parsed.plan.dateTo,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Reading

export const searchTermNoteCodes = [
  'not_search_volume',
  'other_grouped',
  'legacy_metrics_unverified',
  'overlapping_periods',
  'period_rows_dropped',
  'rows_capped',
  'no_listing_text',
] as const;
export type SearchTermNoteCode = (typeof searchTermNoteCodes)[number];
export const searchTermNoteMessages: Record<SearchTermNoteCode, string> = {
  not_search_volume:
    'These are the terms people searched and then opened your listing from. It is not how often a term is searched: terms nobody opened your listing from are not here.',
  other_grouped:
    'Google groups terms that were too small to report on their own into "Other"; they are counted in the totals and cannot be listed.',
  legacy_metrics_unverified:
    "Visitors and installs per term are Google Play's legacy store listing metrics. Google changed its store listing reports in 2026, so check them against the console (UNVERIFIED).",
  overlapping_periods:
    'Two imported files cover overlapping periods, so some days may be counted twice.',
  period_rows_dropped:
    'Rows of a file without dates were left out for a country that also has daily rows, so a day is not counted twice.',
  rows_capped: 'The period holds more rows than are read at once. Choose a shorter period.',
  no_listing_text:
    'No Google Play listing text is stored for this language, so "in your listing" is unknown. Sync the app first.',
};
const note = (code: SearchTermNoteCode) => ({ code, message: searchTermNoteMessages[code] });

export type SearchTermsQuery = {
  from?: string;
  to?: string;
  country?: string;
  locale?: string;
  sort?: string;
  limit?: number;
};

export type SearchTermsView = {
  appId: string;
  platform: 'android';
  from: string | null;
  to: string | null;
  country: string | null;
  sort: SearchTermSort;
  /** The listing locale the "in your listing" check used, and the one the stored listing text came from. */
  locale: string;
  listingLocale: string | null;
  listingReadAt: number | null;
  /** The latest import: null when nothing was imported. */
  imported: {
    at: number;
    periodFrom: string | null;
    periodTo: string | null;
    imports: number;
  } | null;
  /** What is stored for the app, whatever the view asks for. */
  stored: { from: string; to: string; countries: string[]; rows: number } | null;
  terms: SearchTermInsight[];
  termCount: number;
  other: SearchTermsSummary['other'];
  totals: SearchTermsSummary['totals'];
  notes: { code: SearchTermNoteCode; message: string }[];
};

export function checkSearchTermsQuery(query: SearchTermsQuery):
  | {
      ok: true;
      from?: string;
      to?: string;
      country?: string;
      sort: SearchTermSort;
      limit: number;
      locale?: string;
    }
  | { ok: false; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  let country: string | undefined;
  if (query.from !== undefined && query.from !== '' && !isIsoDate(query.from))
    issues.push({ path: 'from', message: 'A day, YYYY-MM-DD.' });
  if (query.to !== undefined && query.to !== '' && !isIsoDate(query.to))
    issues.push({ path: 'to', message: 'A day, YYYY-MM-DD.' });
  if (query.from && query.to && isIsoDate(query.from) && isIsoDate(query.to)) {
    if (query.from > query.to) issues.push({ path: 'from', message: 'from is after to.' });
    else if (daysBetween(query.from, query.to) + 1 > searchTermLimits.maxPeriodDays)
      issues.push({ path: 'to', message: `At most ${searchTermLimits.maxPeriodDays} days.` });
  }
  if (query.country !== undefined && query.country !== '') {
    country = normalizeCountry(query.country);
    if (!country)
      issues.push({ path: 'country', message: 'A storefront of two letters, such as us.' });
  }
  if (query.sort !== undefined && query.sort !== '' && !isSearchTermSort(query.sort))
    issues.push({ path: 'sort', message: 'Use installs or visitors.' });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(country ? { country } : {}),
    ...(query.locale ? { locale: query.locale } : {}),
    sort: isSearchTermSort(query.sort) ? query.sort : 'installs',
    limit: Math.min(
      Math.max(query.limit ?? searchTermLimits.defaultLimit, 1),
      searchTermLimits.maxLimit,
    ),
  };
}

/** The top terms of a period for a Google Play app, with tracked and in-the-listing marks. Reads the database only. */
export async function searchTermsFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  query: {
    from?: string;
    to?: string;
    country?: string;
    locale?: string;
    sort: SearchTermSort;
    limit: number;
  },
): Promise<SearchTermsView> {
  const importedRow = (
    await sql.query(
      'SELECT last_import_at, last_period_from, last_period_to, imports FROM play_search_term_imports WHERE app_id = ? AND workspace_id = ?',
      [app.id, workspaceId],
    )
  )[0];
  const imported = importedRow
    ? {
        at: Number(importedRow.last_import_at),
        periodFrom:
          importedRow.last_period_from === null ? null : String(importedRow.last_period_from),
        periodTo: importedRow.last_period_to === null ? null : String(importedRow.last_period_to),
        imports: Number(importedRow.imports),
      }
    : null;
  const cover = (
    await sql.query(
      'SELECT MIN(period_from) AS first_day, MAX(period_to) AS last_day, COUNT(*) AS n FROM play_search_terms WHERE app_id = ? AND workspace_id = ?',
      [app.id, workspaceId],
    )
  )[0];
  const rowsStored = cover ? Number(cover.n) : 0;
  const locale = query.locale ?? (await defaultLocale(sql, workspaceId, app.id));
  const base = {
    appId: app.id,
    platform: 'android' as const,
    country: query.country ?? null,
    sort: query.sort,
    locale,
    imported,
  };
  if (rowsStored === 0 || !cover || cover.first_day === null || cover.last_day === null) {
    return {
      ...base,
      from: query.from ?? null,
      to: query.to ?? null,
      listingLocale: null,
      listingReadAt: null,
      stored: null,
      terms: [],
      termCount: 0,
      other: null,
      totals: { visitors: null, installs: null },
      notes: [note('not_search_volume')],
    };
  }
  const countryRows = await sql.query(
    'SELECT DISTINCT country FROM play_search_terms WHERE app_id = ? AND workspace_id = ? AND country <> ? ORDER BY country LIMIT 300',
    [app.id, workspaceId, ''],
  );
  const stored = {
    from: String(cover.first_day),
    to: String(cover.last_day),
    countries: countryRows.map((r) => String(r.country)),
    rows: rowsStored,
  };
  // Default: everything stored (at most the newest 400 days).
  const to = query.to ?? stored.to;
  const earliest = addDays(to, -(searchTermLimits.maxPeriodDays - 1));
  const from = query.from ?? (stored.from < earliest ? earliest : stored.from);

  const where = ['app_id = ?', 'workspace_id = ?', 'period_from >= ?', 'period_to <= ?'];
  const params: Param[] = [app.id, workspaceId, from, to];
  if (query.country) {
    where.push('country = ?');
    params.push(query.country);
  }
  const raw = await sql.query(
    `SELECT country, period_from, period_to, term_key, term, visitors, installs, conversion_micro FROM play_search_terms WHERE ${where.join(' AND ')} LIMIT ${searchTermLimits.maxRowsRead + 1}`,
    params,
  );
  const capped = raw.length > searchTermLimits.maxRowsRead;
  const points: SearchTermPoint[] = raw.slice(0, searchTermLimits.maxRowsRead).map((r) => ({
    country: String(r.country),
    from: String(r.period_from),
    to: String(r.period_to),
    key: String(r.term_key),
    term: String(r.term),
    visitors: nullableNumber(r.visitors),
    installs: nullableNumber(r.installs),
    conversion: r.conversion_micro === null ? null : Number(r.conversion_micro) / 1_000_000,
  }));
  const summary = summariseSearchTerms(points, {
    from,
    to,
    ...(query.country ? { country: query.country } : {}),
    sort: query.sort,
    limit: query.limit,
  });

  const tracked = (await listKeywords(sql, workspaceId, app.id)).map((k) => ({
    id: k.id,
    key: k.key,
    country: k.country,
  }));
  const own = await ownFields(sql, workspaceId, app, locale);
  const fields: FitFields | null = own.found ? own.found.fields : null;
  const terms = searchTermInsights(summary.terms, {
    locale,
    fields,
    tracked,
    ...(query.country ? { country: query.country } : {}),
  });

  const notes = [note('not_search_volume'), note('legacy_metrics_unverified')];
  if (summary.other !== null) notes.push(note('other_grouped'));
  if (summary.overlappingPeriods) notes.push(note('overlapping_periods'));
  if (summary.droppedPeriodRows > 0) notes.push(note('period_rows_dropped'));
  if (capped) notes.push(note('rows_capped'));
  if (fields === null) notes.push(note('no_listing_text'));
  return {
    ...base,
    from,
    to,
    listingLocale: own.found ? own.found.locale : null,
    listingReadAt: own.readAt,
    stored,
    terms,
    termCount: summary.termCount,
    other: summary.other,
    totals: summary.totals,
    notes,
  };
}
