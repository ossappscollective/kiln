import type { FileChange } from '@mrm/core';
import type { AssetHandle } from './asset-repo.ts';
import type { PlanStep } from './asset-repo-plan.ts';

/**
 * Turns the steps of a plan (asset-repo-plan.ts) into the file changes of a change set: reads the bytes the steps need from
 * the repository at the commit that was indexed, holds each to the blob id the plan was made from (a file that changed since
 * is not touched), and writes base64 text (`encoding: 'base64'`, core/changeset.ts). Nothing is written anywhere here.
 */

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const nameOf = (path: string): string => path.split('/').pop() ?? path;

export type StepsOutcome = {
  changes: FileChange[];
  written: number;
  deleted: number;
  /** One sentence per step that was left out, with the reason. */
  failures: string[];
  /** Bytes read from the repository. */
  readBytes: number;
};

export async function stepsToChanges(input: {
  handle: AssetHandle;
  steps: readonly PlanStep[];
  /** The bytes of a new file, by its index in the wanted list. */
  newBytes: (index: number) => Uint8Array | undefined;
}): Promise<StepsOutcome> {
  const out: StepsOutcome = { changes: [], written: 0, deleted: 0, failures: [], readBytes: 0 };
  const readOld = async (path: string, oid: string | null): Promise<Uint8Array | undefined> => {
    const file = await input.handle.readFile(path);
    if (!file.ok || (oid !== null && file.oid !== oid)) return undefined;
    out.readBytes += file.bytes.length;
    return file.bytes;
  };
  for (const step of input.steps) {
    if (step.op === 'delete') {
      const old = await readOld(step.path, step.oid);
      if (!old) {
        out.failures.push(
          `${nameOf(step.path)} could not be read from the repository at the commit that was indexed, so it was not removed.`,
        );
        continue;
      }
      out.changes.push({ path: step.path, before: b64(old), encoding: 'base64' });
      out.deleted++;
      continue;
    }
    const bytes =
      step.from.kind === 'new'
        ? input.newBytes(step.from.index)
        : await readOld(step.from.path, step.oid);
    if (!bytes) {
      out.failures.push(`${nameOf(step.path)} could not be prepared.`);
      continue;
    }
    let before: string | undefined;
    if (step.replacesOid !== null) {
      const old = await readOld(step.path, step.replacesOid);
      if (!old) {
        out.failures.push(
          `${nameOf(step.path)} changed in the repository since it was indexed, so it was not replaced.`,
        );
        continue;
      }
      before = b64(old);
    }
    out.changes.push({
      path: step.path,
      ...(before !== undefined ? { before } : {}),
      after: b64(bytes),
      encoding: 'base64',
    });
    out.written++;
  }
  return out;
}
