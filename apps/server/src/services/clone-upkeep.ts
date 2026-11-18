import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { type ClonedRepository, type CloneSize, cloneSize, isCloneBusy, listClones } from '@mrm/connectors';
import type { Sql } from '@mrm/db';
import { recordAudit } from './audit.ts';
import type { CloneReads } from './clone-reads.ts';
import { localCloneId } from './local-reads.ts';

/**
 * Upkeep of the managed clone folder (MRM_CLONE_DIR, docs/adr/0005-local-clone-reads.md, "Clone
 * upkeep"). The clones are a cache of what GitHub (or an attached local folder) holds: removing
 * one costs a fetch on its next read, which happens by itself (a reader makes a missing clone
 * again), so nothing here can lose data.
 *
 * A sweep removes
 *   1. clones unused for longer than `idleDays` (MRM_CLONE_IDLE_DAYS, 0 never), then
 *   2. the least recently used ones until the folder is within `maxBytes` (MRM_CLONE_MAX_BYTES, 0
 *      no limit),
 * never a clone that is in use (its lock is held or waited for in this process, or it was used in
 * the last `IN_USE_GRACE_MS`, which covers the time between two git calls of one request), and
 * never anything but a real folder with our marker directly under a workspace folder whose real
 * path is inside the clone folder: `listClones` refuses links and strangers, and the removal
 * itself (`GitCloneReader.remove` / `removeClone`) checks again. A clone is removed through the
 * pool (`CloneReads.remove`), so the reader's caches are cleared with it.
 */

/** A clone used this recently is not pruned: a request may be between two git calls. */
export const IN_USE_GRACE_MS = 10 * 60_000;
const DAY_MS = 24 * 3600_000;
/** How long a measured size is reused by the read-only listing. A sweep always measures again. */
export const SIZE_TTL_MS = 10 * 60_000;

/** Defaults of MRM_CLONE_MAX_BYTES and MRM_CLONE_IDLE_DAYS (config.ts reads the same numbers). */
export const DEFAULT_CLONE_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_CLONE_IDLE_DAYS = 30;

export type CloneUpkeepConfig = {
  /** Most bytes the clone folder may hold; 0 is no limit. */
  maxBytes: number;
  /** A clone unused for this many days goes; 0 never. */
  idleDays: number;
};

export type SweepSummary = {
  /** Managed clones found. */
  scanned: number;
  removed: number;
  /** Of those, removed for being idle, and removed to get under the byte limit. */
  idle: number;
  budget: number;
  freedBytes: number;
  /** Clones that were due but in use. */
  skippedInUse: number;
  /** Removals that did not take. */
  failed: number;
  /** Links and strangers that were not touched. */
  refused: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Still over the limit after the sweep (everything else was in use). */
  overBudget: boolean;
};

export type CloneView = {
  repositoryId: string;
  /** `owner/repo`, the folder name of a local-only repository, or null when no repository has this id (left over). */
  name: string | null;
  /** `github`: the clone of the GitHub repository. `local`: the managed copy of an attached local folder. */
  kind: 'github' | 'local';
  bytes: number;
  /** The size walk reached its cap: `bytes` is a lower bound. */
  sizeIsLowerBound: boolean;
  /** Epoch milliseconds. */
  lastUsedAt: number;
  createdAt: number | null;
  /** A read is running or just ran: it will not be pruned now. */
  inUse: boolean;
};

export type CloneReport = {
  /** False when reads do not use clones (MRM_READS=api): nothing is kept on disk. */
  enabled: boolean;
  clones: CloneView[];
  /** The bytes of these clones (this workspace's). The limit below is for the whole folder. */
  totalBytes: number;
  limits: { maxBytes: number; idleDays: number };
};

export type PurgeResult = { removed: number; freedBytes: number };

export type CloneUpkeep = {
  readonly config: CloneUpkeepConfig;
  /** One pass over the folder. Never throws. */
  sweep(): Promise<SweepSummary>;
  /** The clones of one workspace, with sizes (cached for ten minutes) and last use. */
  report(workspaceId: string): Promise<CloneReport>;
  /** The clone of one repository of this workspace, or undefined when there is none. */
  forRepository(workspaceId: string, repositoryId: string): Promise<CloneView | undefined>;
  /** Removes the clones of one repository now. `busy`: something is reading it; nothing was removed. */
  purge(
    workspaceId: string,
    repositoryId: string,
    actor: { type: 'user' | 'token' | 'assistant' | 'system'; id: string },
  ): Promise<({ ok: true } & PurgeResult) | { ok: false; reason: 'busy' }>;
};

export type CloneUpkeepOptions = {
  reads: CloneReads;
  db: Sql;
  config: CloneUpkeepConfig;
  now?: () => number;
  /** One line to the server log. Default `console.log`. */
  log?: (line: string) => void;
  /** Most entries one size walk visits. Default 200000. */
  maxEntries?: number;
};

type Entry = ClonedRepository & { inUse: boolean };

export function createCloneUpkeep(options: CloneUpkeepOptions): CloneUpkeep {
  const { reads, db, config } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const cloneDir = reads.cloneDir;
  const sizes = new Map<string, { size: CloneSize; at: number }>();

  const measure = (dir: string) => cloneSize(dir, options.maxEntries);
  const cachedSize = async (dir: string): Promise<CloneSize> => {
    const hit = sizes.get(dir);
    if (hit && now() - hit.at < SIZE_TTL_MS) return hit.size;
    const size = await measure(dir);
    sizes.set(dir, { size, at: now() });
    return size;
  };

  const inUse = (clone: ClonedRepository): boolean =>
    isCloneBusy(cloneDir, clone.workspaceId, clone.cloneId) || now() - clone.lastUsedAt < IN_USE_GRACE_MS;

  const gone = async (clone: ClonedRepository): Promise<boolean> =>
    (await lstat(join(cloneDir, clone.workspaceId, clone.cloneId)).catch(() => undefined)) === undefined;

  /** Removes one clone through the pool. True when it is gone afterwards. */
  async function removeOne(clone: ClonedRepository): Promise<boolean> {
    await reads.remove(clone.workspaceId, clone.cloneId);
    sizes.delete(clone.dir);
    return gone(clone);
  }

  const repositoryIdOf = (cloneId: string): { id: string; kind: 'github' | 'local' } =>
    cloneId.endsWith('-local') ? { id: cloneId.slice(0, -'-local'.length), kind: 'local' } : { id: cloneId, kind: 'github' };

  async function names(workspaceId: string): Promise<Map<string, string>> {
    const rows = await db.query(
      `SELECT r.id, r.owner, r.repo, k.name AS local_name
         FROM repositories r LEFT JOIN repository_local_checkouts k ON k.repository_id = r.id
        WHERE r.workspace_id = ?`,
      [workspaceId],
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      const name = row.owner && row.repo ? `${String(row.owner)}/${String(row.repo)}` : String(row.local_name ?? 'Local repository');
      out.set(String(row.id), name);
    }
    return out;
  }

  const view = (clone: Entry, known: Map<string, string>): CloneView => {
    const { id, kind } = repositoryIdOf(clone.cloneId);
    return {
      repositoryId: id,
      name: known.get(id) ?? null,
      kind,
      bytes: clone.bytes,
      sizeIsLowerBound: clone.truncated,
      lastUsedAt: clone.lastUsedAt,
      createdAt: clone.createdAt > 0 ? clone.createdAt : null,
      inUse: clone.inUse,
    };
  };

  async function audit(
    workspaceId: string,
    action: 'clone.prune' | 'clone.purge',
    actor: { type: 'user' | 'token' | 'assistant' | 'system'; id: string },
    detail: Record<string, unknown>,
    target: { type: string; id: string },
  ): Promise<void> {
    try {
      await recordAudit(db, { workspaceId, actor, action, target, detail, at: now() });
    } catch (error) {
      // The workspace may be gone (its clones are what is left): the removal stands.
      log(`Clones: could not record ${action} for workspace ${workspaceId} (${(error as Error).name}).`);
    }
  }

  async function sweep(): Promise<SweepSummary> {
    const summary: SweepSummary = {
      scanned: 0,
      removed: 0,
      idle: 0,
      budget: 0,
      freedBytes: 0,
      skippedInUse: 0,
      failed: 0,
      refused: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      overBudget: false,
    };
    try {
      const listed = await listClones(cloneDir, { size: measure });
      summary.refused = listed.refused;
      const clones = listed.clones;
      summary.scanned = clones.length;
      summary.bytesBefore = clones.reduce((sum, c) => sum + c.bytes, 0);
      let remaining = summary.bytesBefore;
      const removedBy = new Map<string, { removed: number; idle: number; budget: number; freedBytes: number }>();
      const note = (clone: ClonedRepository, reason: 'idle' | 'budget') => {
        const entry = removedBy.get(clone.workspaceId) ?? { removed: 0, idle: 0, budget: 0, freedBytes: 0 };
        entry.removed++;
        entry[reason]++;
        entry.freedBytes += clone.bytes;
        removedBy.set(clone.workspaceId, entry);
        summary.removed++;
        summary[reason]++;
        summary.freedBytes += clone.bytes;
        remaining -= clone.bytes;
      };
      const skipped = new Set<string>();
      const tryRemove = async (clone: ClonedRepository, reason: 'idle' | 'budget'): Promise<void> => {
        if (inUse(clone)) {
          skipped.add(clone.dir);
          return;
        }
        try {
          if (await removeOne(clone)) note(clone, reason);
          else summary.failed++;
        } catch {
          summary.failed++;
        }
      };

      const leftover: ClonedRepository[] = [];
      for (const clone of clones) {
        if (config.idleDays > 0 && now() - clone.lastUsedAt > config.idleDays * DAY_MS) {
          await tryRemove(clone, 'idle');
          if (!(await gone(clone))) leftover.push(clone);
        } else {
          leftover.push(clone);
        }
      }
      if (config.maxBytes > 0 && remaining > config.maxBytes) {
        // Least recently used first. A clone already counted as skipped (in use) is not asked again.
        const oldestFirst = leftover
          .filter((c) => !inUse(c))
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.cloneId.localeCompare(b.cloneId));
        for (const clone of oldestFirst) {
          if (remaining <= config.maxBytes) break;
          await tryRemove(clone, 'budget');
        }
        summary.overBudget = remaining > config.maxBytes;
        // What was in use and would have been needed.
        if (summary.overBudget) for (const c of leftover) if (inUse(c)) skipped.add(c.dir);
      }
      summary.skippedInUse = skipped.size;
      summary.bytesAfter = Math.max(remaining, 0);

      for (const [workspaceId, counts] of removedBy) {
        await audit(
          workspaceId,
          'clone.prune',
          { type: 'system', id: 'clone-sweep' },
          { ...counts, maxBytes: config.maxBytes, idleDays: config.idleDays },
          { type: 'workspace', id: workspaceId },
        );
      }
      if (summary.removed > 0 || summary.overBudget || summary.failed > 0) {
        log(
          `Clones: removed ${summary.removed} (${summary.idle} idle, ${summary.budget} over the limit), freed ${summary.freedBytes} bytes, ${summary.bytesAfter} bytes left` +
            `${summary.skippedInUse > 0 ? `, ${summary.skippedInUse} in use` : ''}${summary.failed > 0 ? `, ${summary.failed} could not be removed` : ''}${summary.overBudget ? '. Still over MRM_CLONE_MAX_BYTES.' : '.'}`,
        );
      }
    } catch (error) {
      log(`Clones: the sweep failed (${(error as Error).name}).`);
    }
    return summary;
  }

  async function entries(workspaceId: string): Promise<Entry[]> {
    const listed = await listClones(cloneDir, { workspaceId, size: cachedSize });
    return listed.clones.map((c) => ({ ...c, inUse: inUse(c) }));
  }

  return {
    config,
    sweep,
    async report(workspaceId) {
      const known = await names(workspaceId);
      const found = reads.active ? await entries(workspaceId) : [];
      const clones = found.map((c) => view(c, known)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      return {
        enabled: reads.active,
        clones,
        totalBytes: clones.reduce((sum, c) => sum + c.bytes, 0),
        limits: { maxBytes: config.maxBytes, idleDays: config.idleDays },
      };
    },
    async forRepository(workspaceId, repositoryId) {
      const known = await names(workspaceId);
      const own = new Set([repositoryId, localCloneId(repositoryId)]);
      const found = (await entries(workspaceId)).filter((c) => own.has(c.cloneId));
      if (found.length === 0) return undefined;
      // A repository with an attached folder has two clones: show them as one.
      const views = found.map((c) => view(c, known));
      const first = views[0] as CloneView;
      return views.length === 1
        ? first
        : {
            ...first,
            kind: 'github',
            bytes: views.reduce((sum, v) => sum + v.bytes, 0),
            sizeIsLowerBound: views.some((v) => v.sizeIsLowerBound),
            lastUsedAt: Math.max(...views.map((v) => v.lastUsedAt)),
            inUse: views.some((v) => v.inUse),
          };
    },
    async purge(workspaceId, repositoryId, actor) {
      const own = new Set([repositoryId, localCloneId(repositoryId)]);
      const found = (await entries(workspaceId)).filter((c) => own.has(c.cloneId));
      // Busy means a lock is held now; recent use alone does not stop a person who asked.
      if (found.some((c) => isCloneBusy(cloneDir, c.workspaceId, c.cloneId))) return { ok: false, reason: 'busy' };
      let removed = 0;
      let freedBytes = 0;
      for (const clone of found) {
        if (await removeOne(clone)) {
          removed++;
          freedBytes += clone.bytes;
        }
      }
      if (removed > 0) {
        await audit(
          workspaceId,
          'clone.purge',
          actor,
          { removed, freedBytes },
          { type: 'repository', id: repositoryId },
        );
      }
      return { ok: true, removed, freedBytes };
    },
  };
}
