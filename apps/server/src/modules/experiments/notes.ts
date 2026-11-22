import { randomUUID } from 'node:crypto';
import type { Sql } from '@kiln/db';
import { z } from 'zod';
import { MAX_NOTES_PER_APP } from './shared.ts';

/**
 * The manual tracker (migration 53): what a person writes down about an experiment or a custom page. It is the only way to keep track of Google Play
 * store listing experiments and custom store listings, which the Google Play Developer API does not expose, and works for any app. Nothing here
 * talks to a store.
 */

export const NOTE_KINDS = ['experiment', 'custom_page'] as const;
export const NOTE_STATUSES = ['planned', 'running', 'finished', 'stopped'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export type NoteView = {
  id: string;
  kind: NoteKind;
  name: string;
  status: NoteStatus;
  /** YYYY-MM-DD. */
  startedOn: string | null;
  endedOn: string | null;
  url: string | null;
  /** The Google Play custom store listing parameter (the `listing=` of its address). */
  listing: string | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date.');

const link = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'An http or https address.');

/** The fields a person sets. `null` clears an optional one. */
const fields = {
  kind: z.enum(NOTE_KINDS),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((v) => !/[\u0000-\u001f]/.test(v), 'One line.'),
  status: z.enum(NOTE_STATUSES),
  startedOn: day.nullable(),
  endedOn: day.nullable(),
  url: link.nullable(),
  listing: z
    .string()
    .regex(
      /^[a-z0-9._~-]{1,100}$/,
      'Lowercase letters, digits and . - _ ~ (Google Play’s rule for a listing parameter).',
    )
    .nullable(),
  note: z.string().max(2000),
};

export const createNoteBody = z
  .object({
    kind: fields.kind,
    name: fields.name,
    status: fields.status.default('planned'),
    startedOn: fields.startedOn.optional(),
    endedOn: fields.endedOn.optional(),
    url: fields.url.optional(),
    listing: fields.listing.optional(),
    note: fields.note.default(''),
  })
  .strict();

export const updateNoteBody = z
  .object({
    name: fields.name.optional(),
    status: fields.status.optional(),
    startedOn: fields.startedOn.optional(),
    endedOn: fields.endedOn.optional(),
    url: fields.url.optional(),
    listing: fields.listing.optional(),
    note: fields.note.optional(),
  })
  .strict();

export type CreateNote = z.infer<typeof createNoteBody>;
export type UpdateNote = z.infer<typeof updateNoteBody>;

/** An end date before the start date is a mistake a person would want to hear about. */
export const datesProblem = (startedOn: string | null, endedOn: string | null): string | null =>
  startedOn !== null && endedOn !== null && endedOn < startedOn
    ? 'The end date is before the start date.'
    : null;

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const noteOf = (row: Record<string, unknown>): NoteView => ({
  id: String(row.id),
  kind: String(row.kind) as NoteKind,
  name: String(row.name),
  status: String(row.status) as NoteStatus,
  startedOn: text(row.started_on),
  endedOn: text(row.ended_on),
  url: text(row.url),
  listing: text(row.listing),
  note: String(row.note ?? ''),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export async function listNotes(sql: Sql, workspaceId: string, appId: string): Promise<NoteView[]> {
  const rows = await sql.query(
    'SELECT * FROM store_experiment_notes WHERE app_id = ? AND workspace_id = ? ORDER BY updated_at DESC, id',
    [appId, workspaceId],
  );
  return rows.map(noteOf);
}

export async function getNote(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<NoteView | null> {
  const [row] = await sql.query(
    'SELECT * FROM store_experiment_notes WHERE id = ? AND app_id = ? AND workspace_id = ?',
    [id, appId, workspaceId],
  );
  return row ? noteOf(row) : null;
}

export async function countNotes(sql: Sql, workspaceId: string, appId: string): Promise<number> {
  const [row] = await sql.query(
    'SELECT COUNT(*) AS n FROM store_experiment_notes WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  return Number(row?.n ?? 0);
}

export async function insertNote(
  sql: Sql,
  input: { workspaceId: string; appId: string; actorId: string; at: number; note: CreateNote },
): Promise<NoteView> {
  const { note } = input;
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO store_experiment_notes
       (id, workspace_id, app_id, kind, name, status, started_on, ended_on, url, listing, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.appId,
      note.kind,
      note.name,
      note.status,
      note.startedOn ?? null,
      note.endedOn ?? null,
      note.url ?? null,
      note.listing ?? null,
      note.note,
      input.actorId,
      input.at,
      input.at,
    ],
  );
  return {
    id,
    kind: note.kind,
    name: note.name,
    status: note.status,
    startedOn: note.startedOn ?? null,
    endedOn: note.endedOn ?? null,
    url: note.url ?? null,
    listing: note.listing ?? null,
    note: note.note,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** The note with the changes applied (a field that is absent stays; `null` clears an optional one). */
export function merged(current: NoteView, changes: UpdateNote, at: number): NoteView {
  return {
    ...current,
    name: changes.name ?? current.name,
    status: changes.status ?? current.status,
    startedOn: changes.startedOn === undefined ? current.startedOn : changes.startedOn,
    endedOn: changes.endedOn === undefined ? current.endedOn : changes.endedOn,
    url: changes.url === undefined ? current.url : changes.url,
    listing: changes.listing === undefined ? current.listing : changes.listing,
    note: changes.note ?? current.note,
    updatedAt: at,
  };
}

export async function saveNote(
  sql: Sql,
  workspaceId: string,
  appId: string,
  next: NoteView,
): Promise<void> {
  await sql.execute(
    `UPDATE store_experiment_notes SET name = ?, status = ?, started_on = ?, ended_on = ?, url = ?, listing = ?, note = ?, updated_at = ?
      WHERE id = ? AND app_id = ? AND workspace_id = ?`,
    [
      next.name,
      next.status,
      next.startedOn,
      next.endedOn,
      next.url,
      next.listing,
      next.note,
      next.updatedAt,
      next.id,
      appId,
      workspaceId,
    ],
  );
}

export async function deleteNote(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<void> {
  await sql.execute(
    'DELETE FROM store_experiment_notes WHERE id = ? AND app_id = ? AND workspace_id = ?',
    [id, appId, workspaceId],
  );
}

export { MAX_NOTES_PER_APP };
