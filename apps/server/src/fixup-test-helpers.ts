import type { PullRequestInfo } from '@mrm/connectors';
import { BranchMovedError } from '@mrm/connectors';
import { FakeRepo } from './repo-test-helpers.ts';

/**
 * A fake GitHub repository that can also add a commit to an existing branch (the connector's
 * `branchTip`, `commitOnBranch` and `findPullRequest`), for the fix-up tests. Not a test file.
 */

type Commit = { sha: string; parent?: string; tree: Map<string, string> };

export class BranchRepo extends FakeRepo {
  commits: Commit[] = [];
  heads = new Map<string, string>();
  commitCalls: {
    branch: string;
    expectedTip: string;
    changes: { path: string; content?: string }[];
    message: string;
  }[] = [];
  pr: PullRequestInfo | undefined;
  moveOnCommit = false;
  commitError: unknown;
  #n = 0;

  override async propose(...args: Parameters<FakeRepo['propose']>) {
    const result = await super.propose(...args);
    const tree = this.branches.get(result.branch) as Map<string, string>;
    const sha = `c${++this.#n}`.padEnd(40, '0');
    this.commits.push({ sha, tree });
    this.heads.set(result.branch, sha);
    this.pr = {
      number: result.number ?? 1,
      state: 'open',
      branch: result.branch,
      base: 'main',
      ...(result.url ? { url: result.url } : {}),
    };
    return { ...result, commitSha: sha };
  }
  async branchTip(branch: string) {
    return this.heads.get(branch);
  }
  override async readFile(path: string, ref?: string) {
    const commit = this.commits.find((c) => c.sha === ref);
    return commit ? commit.tree.get(path) : this.files.get(path);
  }
  async findPullRequest() {
    return this.pr;
  }
  async commitOnBranch(options: {
    branch: string;
    expectedTip: string;
    changes: { path: string; content?: string }[];
    message: string;
  }) {
    this.commitCalls.push(options);
    if (this.commitError) throw this.commitError;
    const tip = this.heads.get(options.branch);
    if (this.moveOnCommit || tip !== options.expectedTip)
      throw new BranchMovedError(options.branch);
    const parent = this.commits.find((c) => c.sha === tip) as Commit;
    const tree = new Map(parent.tree);
    for (const change of options.changes) {
      if (change.content === undefined) tree.delete(change.path);
      else tree.set(change.path, change.content);
    }
    const sha = `c${++this.#n}`.padEnd(40, '0');
    this.commits.push({ sha, parent: tip, tree });
    this.heads.set(options.branch, sha);
    return {
      commit: sha,
      parent: options.expectedTip,
      tree: `t${this.#n}`,
      changed: options.changes.length,
    };
  }
}
