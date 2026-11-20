/**
 * Response bodies shaped like GitHub's REST API (version 2022-11-28), trimmed to the fields the
 * connector reads. They are written from the documented examples, not recorded from a live
 * GitHub; see docs/spikes/repo-conventions.md.
 */

export const SHA_BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHA_TREE = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
export const SHA_NEW_COMMIT = 'c3d4e5f60718293a4b5c6d7e8f90123456789012';
export const SHA_NEW_TREE = 'd4e5f60718293a4b5c6d7e8f9012345678901234';

export const repo = (defaultBranch = 'main') => ({
  id: 1296269,
  name: 'trail-notes',
  full_name: 'acme/trail-notes',
  private: true,
  default_branch: defaultBranch,
});

export const ref = (name: string, sha: string, type: 'commit' | 'tag' = 'commit') => ({
  ref: `refs/${name}`,
  object: { type, sha, url: `https://api.github.com/repos/acme/trail-notes/git/${type}s/${sha}` },
});

export const commit = (sha: string, treeSha: string) => ({
  sha,
  tree: { sha: treeSha },
  message: 'previous',
});

export type TreeEntry = {
  path: string;
  mode?: string;
  type?: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
};

export const tree = (sha: string, entries: TreeEntry[], truncated = false) => ({
  sha,
  truncated,
  tree: entries.map((e) => ({ mode: '100644', type: 'blob', ...e })),
});

export const file = (path: string, content: string, sha: string) => ({
  type: 'file',
  encoding: 'base64',
  size: Buffer.byteLength(content),
  name: path.split('/').pop(),
  path,
  // GitHub wraps base64 at 60 characters.
  content: `${(
    Buffer.from(content)
      .toString('base64')
      .match(/.{1,60}/g) ?? []
  ).join('\n')}\n`,
  sha,
});

export const largeFile = (path: string, size: number, sha: string) => ({
  type: 'file',
  encoding: 'none',
  size,
  name: path.split('/').pop(),
  path,
  content: '',
  sha,
});

export const blob = (content: Buffer | string) => ({
  encoding: 'base64',
  content: Buffer.from(content).toString('base64'),
});

export const pullRequest = (number: number, branch: string) => ({
  number,
  state: 'open',
  html_url: `https://github.com/acme/trail-notes/pull/${number}`,
  head: { ref: branch },
});

export const installationToken = (token: string, expiresAt: string) => ({
  token,
  expires_at: expiresAt,
  permissions: { contents: 'write', pull_requests: 'write', actions: 'write' },
  repository_selection: 'selected',
});

export const dispatchWithRun = (runId: number) => ({
  workflow_run_id: runId,
  run_url: `https://api.github.com/repos/acme/trail-notes/actions/runs/${runId}`,
  html_url: `https://github.com/acme/trail-notes/actions/runs/${runId}`,
});

export const workflowRuns = () => ({
  total_count: 2,
  workflow_runs: [
    {
      id: 30433642,
      name: 'Release',
      head_branch: 'main',
      head_sha: SHA_BASE,
      run_number: 562,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/trail-notes/actions/runs/30433642',
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:12:30Z',
    },
    {
      id: 30433643,
      name: 'Release',
      head_branch: 'release/1.2',
      head_sha: SHA_NEW_COMMIT,
      run_number: 563,
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/acme/trail-notes/actions/runs/30433643',
      created_at: '2026-03-02T09:00:00Z',
      updated_at: '2026-03-02T09:01:00Z',
    },
    // A run without a URL cannot be linked to, so it is dropped.
    { id: 1, status: 'queued' },
  ],
});
