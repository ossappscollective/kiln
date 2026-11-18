/**
 * Reading the bytes of files (images) from a repository without decoding them: the shapes shared by
 * the connectors that can do it (`GitCloneReader` for a managed or local clone, `GithubRepoConnector`
 * for the REST API) and by the server's asset index.
 *
 * `readFile` of the other reads is for text and refuses anything that is not UTF-8. These two
 * methods are for binary files, and they are bounded on purpose:
 *
 * - `listBlobEntries` names every file of a commit with its object id (and its size when the host
 *   gives it for free: the GitHub tree does, `git ls-tree` without `-l` does not). A symlink and a
 *   submodule are not listed.
 * - `readBlobHeads` returns, for each path asked, only the first `headBytes` bytes (an image header
 *   is a few hundred bytes), never a file larger than `maxFileBytes`, and stops pulling files over
 *   the network once `maxTransferBytes` have been transferred (the rest is `budget`, so a caller can
 *   say the answer is partial). Nothing is decoded and nothing is written to disk by us.
 */

export type BlobEntry = {
  path: string;
  /** The git object id of the file's content: the identity of the bytes. */
  oid: string;
  mode: string;
  /** Bytes, or null when the source does not say without reading the file. */
  size: number | null;
};

export type BlobListing = { commit: string; entries: BlobEntry[] };

export type BlobHeadItem =
  | {
      ok: true;
      oid: string;
      /** The whole file's size in bytes. */
      size: number;
      /** The first `min(size, headBytes)` bytes. */
      head: Uint8Array;
    }
  | {
      ok: false;
      oid: string | null;
      /**
       * `too_large`: over `maxFileBytes`. `budget`: over the transfer budget. `missing`: no such
       * file or the host did not have it. `unsized`: `headBytes` was 0 (sizes only) and the size is
       * not known without downloading the file.
       */
      reason: 'too_large' | 'budget' | 'missing' | 'unsized';
      size: number | null;
    };

export type BlobHeadsOptions = {
  /** A commit sha (or a ref). Pass the commit of `listBlobEntries` so both see one snapshot. */
  ref?: string;
  /**
   * How many bytes to keep of each file. 0 asks for sizes only (nothing is downloaded to learn a
   * size, so a file whose size is not known for free is `unsized`).
   */
  headBytes: number;
  /** A file larger than this is reported as `too_large` and never read. */
  maxFileBytes: number;
  /** Over the network (a GitHub clone or the API): stop starting transfers past this many bytes in total. */
  maxTransferBytes: number;
  signal?: AbortSignal;
};

export type BlobHeads = {
  /** One entry per requested path (duplicates collapse). */
  items: Map<string, BlobHeadItem>;
  /** Bytes pulled over the network for this call (0 for a local source whose files were present). */
  transferredBytes: number;
};

export interface BlobReads {
  listBlobEntries(ref?: string, options?: { signal?: AbortSignal }): Promise<BlobListing>;
  readBlobHeads(paths: readonly string[], options: BlobHeadsOptions): Promise<BlobHeads>;
}

export const isBlobReads = (value: unknown): value is BlobReads =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<BlobReads>).listBlobEntries === 'function' &&
  typeof (value as Partial<BlobReads>).readBlobHeads === 'function';
