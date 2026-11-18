import { randomUUID } from 'node:crypto';
import { type ActorType, type CredentialKind, checkSecret, credentialKinds, isCredentialKind } from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { decryptSecret, encryptSecret } from '@mrm/vault';
import { recordAudit } from './audit.ts';

export { credentialKinds, type CredentialKind };

export type CredentialSummary = {
  id: string;
  kind: string;
  label: string;
  createdAt: number;
  rotatedAt: number | null;
  /** The last "test connection" on this credential, or null when it was never tested. */
  lastTest: { at: number; ok: boolean; message: string } | null;
};

type Actor = { type: ActorType; id: string };

/**
 * The secret is bound to the workspace and credential id (as AAD), so a ciphertext copied
 * to another row or workspace refuses to decrypt.
 */
export const credentialAad = (workspaceId: string, id: string) =>
  `credential:${workspaceId}:${id}`;

const toSummary = (r: Record<string, unknown>): CredentialSummary => ({
  id: String(r.id),
  kind: String(r.kind),
  label: String(r.label),
  createdAt: Number(r.created_at),
  rotatedAt: r.rotated_at === null || r.rotated_at === undefined ? null : Number(r.rotated_at),
  lastTest:
    r.last_test_at === null || r.last_test_at === undefined
      ? null
      : {
          at: Number(r.last_test_at),
          ok: Number(r.last_test_ok) === 1,
          message: String(r.last_test_message ?? ''),
        },
});

export async function listCredentials(sql: Sql, workspaceId: string): Promise<CredentialSummary[]> {
  const rows = await sql.query(
    `SELECT id, kind, label, created_at, rotated_at, last_test_at, last_test_ok, last_test_message
       FROM credentials
      WHERE workspace_id = ? ORDER BY created_at, id`,
    [workspaceId],
  );
  return rows.map(toSummary);
}

export async function createCredential(
  db: Database,
  key: Buffer,
  input: { workspaceId: string; kind: CredentialKind; label: string; secret: string },
  actor: Actor,
  now: number,
): Promise<CredentialSummary> {
  const id = randomUUID();
  const ciphertext = encryptSecret(input.secret, key, credentialAad(input.workspaceId, id));
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO credentials (id, workspace_id, kind, label, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.workspaceId, input.kind, input.label, ciphertext, now],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'credential.create',
      target: { type: 'credential', id },
      detail: { kind: input.kind, label: input.label },
      at: now,
    });
  });
  return { id, kind: input.kind, label: input.label, createdAt: now, rotatedAt: null, lastTest: null };
}

export type RotateResult = { ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'invalid_secret'; message: string };

export async function rotateCredential(
  db: Database,
  key: Buffer,
  input: { workspaceId: string; id: string; secret: string },
  actor: Actor,
  now: number,
): Promise<RotateResult> {
  return db.transaction(async (tx): Promise<RotateResult> => {
    const [row] = await tx.query('SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    if (!row) return { ok: false, reason: 'not_found' };
    // The kind is fixed at creation, so the new secret must still be a secret of that kind.
    if (isCredentialKind(row.kind)) {
      const message = checkSecret(row.kind, input.secret);
      if (message) return { ok: false, reason: 'invalid_secret', message };
    }
    const ciphertext = encryptSecret(input.secret, key, credentialAad(input.workspaceId, input.id));
    // A new secret has not been tested, so the old result is cleared.
    await tx.execute(
      `UPDATE credentials SET ciphertext = ?, rotated_at = ?,
              last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL
        WHERE id = ? AND workspace_id = ?`,
      [ciphertext, now, input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'credential.rotate',
      target: { type: 'credential', id: input.id },
      at: now,
    });
    return { ok: true };
  });
}

export async function deleteCredential(
  db: Database,
  input: { workspaceId: string; id: string },
  actor: Actor,
  now: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute('DELETE FROM credentials WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    if (changed === 0) return false;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'credential.delete',
      target: { type: 'credential', id: input.id },
      at: now,
    });
    return true;
  });
}

/**
 * For connectors only. No route returns this. Reading a secret is audited, because it is the
 * moment a store key leaves the vault.
 */
export async function useCredentialSecret(
  db: Database,
  key: Buffer,
  input: { workspaceId: string; id: string; purpose: string },
  actor: Actor,
  now: number,
): Promise<string | undefined> {
  const [row] = await db.query('SELECT ciphertext FROM credentials WHERE id = ? AND workspace_id = ?', [
    input.id,
    input.workspaceId,
  ]);
  if (!row) return undefined;
  const secret = decryptSecret(String(row.ciphertext), key, credentialAad(input.workspaceId, input.id));
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    actor,
    action: 'credential.use',
    target: { type: 'credential', id: input.id },
    detail: { purpose: input.purpose },
    at: now,
  });
  return secret;
}

export async function credentialExists(
  sql: Sql,
  input: { workspaceId: string; id: string },
): Promise<boolean> {
  const rows = await sql.query('SELECT id FROM credentials WHERE id = ? AND workspace_id = ?', [
    input.id,
    input.workspaceId,
  ]);
  return rows.length > 0;
}

/** What a saved credential's test needs: its kind, and its secret decrypted (audited as a use). */
export type CredentialForTest =
  | { found: false }
  | { found: true; kind: string; secret: string | undefined };

/**
 * Decrypts a saved credential for a connection test. The secret is undefined when it cannot be
 * decrypted (wrong master key, or a row that was moved). Reading it is audited as `credential.use`.
 */
export async function loadCredentialForTest(
  db: Database,
  key: Buffer,
  input: { workspaceId: string; id: string },
  actor: Actor,
  now: number,
): Promise<CredentialForTest> {
  const [row] = await db.query('SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?', [
    input.id,
    input.workspaceId,
  ]);
  if (!row) return { found: false };
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(db, key, { ...input, purpose: 'connection test' }, actor, now);
  } catch {
    secret = undefined;
  }
  return { found: true, kind: String(row.kind), secret };
}

const MAX_TEST_MESSAGE = 500;

/**
 * Remembers the outcome of a connection test on the credential and audits it. The message is
 * stored for display next to the credential; the audit event carries only whether it passed.
 */
export async function recordCredentialTest(
  db: Database,
  input: { workspaceId: string; id: string; ok: boolean; message: string },
  actor: Actor,
  now: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute(
      `UPDATE credentials SET last_test_at = ?, last_test_ok = ?, last_test_message = ?
        WHERE id = ? AND workspace_id = ?`,
      [now, input.ok ? 1 : 0, input.message.slice(0, MAX_TEST_MESSAGE), input.id, input.workspaceId],
    );
    if (changed === 0) return false;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'credential.test',
      target: { type: 'credential', id: input.id },
      detail: { ok: input.ok },
      at: now,
    });
    return true;
  });
}

/** Audits a test of a secret that was not saved. Nothing about the secret is recorded. */
export async function recordUnsavedCredentialTest(
  db: Database,
  input: { workspaceId: string; kind: CredentialKind; ok: boolean },
  actor: Actor,
  now: number,
): Promise<void> {
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    actor,
    action: 'credential.test',
    detail: { kind: input.kind, ok: input.ok, saved: false },
    at: now,
  });
}
