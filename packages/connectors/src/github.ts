import { createHash, createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { type ChangeSet, checkSecret, type FileChange } from '@mrm/core';
import {
  BranchExistsError,
  ChangeConflictError,
  DefaultBranchError,
  GithubError,
  GithubRateLimitError,
  PullRequestFailedError,
  redactSecrets,
} from './errors.ts';
import type {
  DispatchResult,
  ListWorkflowRunsOptions,
  ProposalResult,
  ProposeOptions,
  RepoConnector,
  WorkflowRun,
} from './types.ts';

/**
 * GitHub through a GitHub App installation (or a personal access token, for trying things out).
 *
 * - All network goes through the injected `fetch`.
 * - The installation token is minted from an app JWT, scoped to this one repository, cached, and
 *   renewed a minute before it expires.
 * - Nothing here logs, and no error message carries a token, a JWT or the private key.
 * - Nothing is retried. A rate limit is a `GithubRateLimitError` that says how long to wait.
 */

export type GithubAuth =
  | { type: 'app'; appId: string; installationId: string; privateKey: string }
  | { type: 'token'; token: string };

export type GithubRepoConnectorOptions = {
  owner: string;
  repo: string;
  auth: GithubAuth;
  /** Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: typeof fetch;
  /** Defaults to https://api.github.com. Set it for GitHub Enterprise Server. */
  apiBase?: string;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Per request. Default 30000. */
  timeoutMs?: number;
  userAgent?: string;
  /** Files larger than this are not read. Default 10 MiB. */
  maxFileBytes?: number;
  /**
   * Paths `propose` refuses to touch. Default `['.github/']`: a change to a workflow file is a
   * change to what CI runs with its secrets, which a listing edit never needs.
   */
  blockedPathPrefixes?: string[];
  /**
   * Ask GitHub for the run id when dispatching (`return_run_details`). On by default; turn it off
   * for a GitHub Enterprise Server that does not know the parameter yet.
   */
  dispatchRunDetails?: boolean;
};

/** Builds `auth` from a stored credential (`github_app` JSON, or a `github_token` string). */
export function githubAuthFromSecret(
  kind: 'github_app' | 'github_token',
  secret: string,
): GithubAuth {
  const problem = checkSecret(kind, secret);
  if (problem) throw new GithubError('invalid_input', problem);
  if (kind === 'github_token') return { type: 'token', token: secret.trim() };
  const parsed = JSON.parse(secret) as Record<string, string>;
  return {
    type: 'app',
    appId: (parsed.appId ?? '').trim(),
    installationId: (parsed.installationId ?? '').trim(),
    privateKey: parsed.privateKey ?? '',
  };
}

type Json = Record<string, unknown>;
type Reply = { status: number; headers: Headers; json: unknown };

const API_VERSION = '2022-11-28';
const SHA = /^[0-9a-f]{40}$/i;
const REFRESH_MARGIN_MS = 60_000;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const enc = (segment: string) => encodeURIComponent(segment);
const encPath = (path: string) => path.split('/').map(enc).join('/');

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** A path inside the repository: no leading slash, no empty, `.` or `..` segment, no `.git`. */
function checkRepoPath(path: string): string {
  const bad =
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git');
  if (bad)
    throw new GithubError('invalid_input', `Not a valid repository path: ${JSON.stringify(path)}.`);
  return path;
}

function checkBranchName(branch: string): string {
  const bad =
    branch === '' ||
    branch.length > 200 ||
    branch === '@' ||
    branch.startsWith('refs/') ||
    /^[-/.]|[/.]$|\.lock$|\.\.|\/\/|@\{|\/\.|\.lock\//.test(branch) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters
    /[\x00-\x20\x7f~^:?*[\\]/.test(branch);
  if (bad)
    throw new GithubError('invalid_input', `Not a valid branch name: ${JSON.stringify(branch)}.`);
  return branch;
}

/**
 * A short-lived JWT that authenticates as the GitHub App itself (not an installation).
 * `iat` is a minute in the past for clock drift; `exp` is well inside the 10 minute maximum.
 */
export function signGithubAppJwt(key: KeyObject, appId: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

export class GithubRepoConnector implements RepoConnector {
  readonly kind = 'github' as const;
  readonly owner: string;
  readonly repo: string;

  readonly #auth: GithubAuth;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #maxFileBytes: number;
  readonly #blocked: string[];
  readonly #runDetails: boolean;
  readonly #key?: KeyObject;
  readonly #secrets = new Set<string>();
  #token?: { value: string; expiresAt: number };
  #tokenRequest?: Promise<string>;
  #defaultBranch?: string;

  constructor(options: GithubRepoConnectorOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#userAgent = options.userAgent ?? 'mobile-release-manager';
    this.#maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.#blocked = options.blockedPathPrefixes ?? ['.github/'];
    this.#runDetails = options.dispatchRunDetails ?? true;
    if (options.auth.type === 'token') {
      this.#secrets.add(options.auth.token);
    } else {
      const pem = options.auth.privateKey;
      this.#secrets.add(pem);
      this.#secrets.add(pem.trim());
      for (const line of pem.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) this.#secrets.add(line.trim());
      }
      try {
        const key = createPrivateKey(pem);
        if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
        this.#key = key;
      } catch {
        // Never include the node error: some versions echo parts of the input.
        throw new GithubError(
          'invalid_input',
          'The GitHub App private key could not be read as an RSA key.',
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Authentication

  #appJwt(): string {
    if (this.#auth.type !== 'app' || !this.#key)
      throw new GithubError('auth', 'No GitHub App configured.');
    const jwt = signGithubAppJwt(this.#key, this.#auth.appId, this.#now());
    this.#secrets.add(jwt);
    return jwt;
  }

  async #installationToken(): Promise<string> {
    if (this.#auth.type === 'token') return this.#auth.token;
    const cached = this.#token;
    if (cached && cached.expiresAt - this.#now() > REFRESH_MARGIN_MS) return cached.value;
    this.#tokenRequest ??= this.#mintToken().finally(() => {
      this.#tokenRequest = undefined;
    });
    return this.#tokenRequest;
  }

  async #mintToken(): Promise<string> {
    if (this.#auth.type !== 'app') throw new GithubError('auth', 'No GitHub App configured.');
    const reply = await this.#send(
      'POST',
      `/app/installations/${enc(this.#auth.installationId)}/access_tokens`,
      { bearer: this.#appJwt(), body: { repositories: [this.repo] } },
    );
    if (reply.status >= 400) {
      const e = this.#errorFrom('POST', 'the installation token endpoint', reply);
      if (e.kind === 'auth') {
        throw new GithubError(
          'auth',
          'GitHub rejected the app JWT. Check the App ID, the private key and the server clock.',
          401,
        );
      }
      if (e.kind === 'not_found') {
        throw new GithubError(
          'auth',
          'GitHub App installation not found. Check the installation ID and that the app is installed.',
          404,
        );
      }
      if (e.kind === 'validation') {
        throw new GithubError(
          'auth',
          `GitHub would not issue a token for ${this.owner}/${this.repo}. Is the repository part of the installation?`,
          422,
        );
      }
      throw e;
    }
    const json = isRecord(reply.json) ? reply.json : {};
    const value = text(json.token);
    const expires = Date.parse(text(json.expires_at) ?? '');
    if (!value || Number.isNaN(expires)) {
      throw new GithubError(
        'unexpected',
        'GitHub returned an installation token response that could not be read.',
      );
    }
    this.#secrets.add(value);
    this.#token = { value, expiresAt: expires };
    return value;
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  async #send(
    method: string,
    path: string,
    options: {
      bearer: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<Reply> {
    const url = new URL(`${this.#base}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.bearer}`,
          'x-github-api-version': API_VERSION,
          'user-agent': this.#userAgent,
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new GithubError('network', `Could not reach GitHub (${method} ${path}): ${name}.`);
    }
    let json: unknown;
    const raw = await response.text().catch(() => '');
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, headers: response.headers, json };
  }

  /** One API call as the installation. A 401 renews the token once and tries again. */
  async #api(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      allow?: number[];
      signal?: AbortSignal;
    } = {},
  ): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new GithubError('network', 'The request was cancelled.');
      const bearer = await this.#installationToken();
      const reply = await this.#send(method, path, {
        bearer,
        body: options.body,
        query: options.query,
        signal: options.signal,
      });
      if (reply.status < 400 || options.allow?.includes(reply.status)) return reply;
      if (reply.status === 401 && attempt === 0 && this.#auth.type === 'app') {
        this.#token = undefined;
        continue;
      }
      throw this.#errorFrom(method, path, reply);
    }
  }

  #errorFrom(method: string, path: string, reply: Reply): GithubError {
    const body = isRecord(reply.json) ? reply.json : {};
    const message = redactSecrets(text(body.message) ?? '', this.#secrets).slice(0, 300);
    const detail = message ? `: ${message}` : '';
    const where = `${method} ${path}`;
    const { status, headers } = reply;
    const remaining = headers.get('x-ratelimit-remaining');
    const retryAfter = headers.get('retry-after');
    const limited =
      status === 429 ||
      (status === 403 && (remaining === '0' || retryAfter !== null || /rate limit/i.test(message)));
    if (limited) {
      const reset = Number(headers.get('x-ratelimit-reset'));
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
      const retry = Number(retryAfter);
      let seconds = 60;
      if (retryAfter !== null && Number.isFinite(retry) && retry >= 0) seconds = Math.ceil(retry);
      else if (resetAt !== undefined && remaining === '0') {
        seconds = Math.max(0, Math.ceil((resetAt - this.#now()) / 1000));
      }
      const primary = remaining === '0' && retryAfter === null && !/secondary/i.test(message);
      return new GithubRateLimitError(status, primary ? 'primary' : 'secondary', seconds, resetAt);
    }
    if (status === 401) {
      return new GithubError('auth', `GitHub rejected the credentials (${where})${detail}`, 401);
    }
    if (status === 403) {
      const needs = headers.get('x-accepted-github-permissions');
      return new GithubError(
        'forbidden',
        `GitHub refused ${where}${detail}${needs ? ` (needs: ${needs.slice(0, 120)})` : ''}`,
        403,
      );
    }
    if (status === 404)
      return new GithubError('not_found', `GitHub could not find ${where}${detail}`, 404);
    if (status === 409)
      return new GithubError('conflict', `GitHub reported a conflict for ${where}${detail}`, 409);
    if (status === 422) {
      const problems = records(body.errors)
        .map((e) => [text(e.resource), text(e.field), text(e.code)].filter(Boolean).join('.'))
        .filter(Boolean)
        .join(', ');
      return new GithubError(
        'validation',
        `GitHub rejected ${where}${detail}${problems ? ` [${problems}]` : ''}`,
        422,
      );
    }
    if (status >= 500)
      return new GithubError('server', `GitHub failed on ${where} (${status})${detail}`, status);
    return new GithubError(
      'unexpected',
      `Unexpected GitHub response ${status} for ${where}${detail}`,
      status,
    );
  }

  #repoPath(suffix: string) {
    return `/repos/${enc(this.owner)}/${enc(this.repo)}${suffix}`;
  }

  // -------------------------------------------------------------------------------------------
  // Refs and trees

  async defaultBranch(signal?: AbortSignal): Promise<string> {
    if (this.#defaultBranch) return this.#defaultBranch;
    const { json } = await this.#api('GET', this.#repoPath(''), { signal });
    const name = isRecord(json) ? text(json.default_branch) : undefined;
    if (!name)
      throw new GithubError('unexpected', 'GitHub did not say which branch is the default.');
    this.#defaultBranch = name;
    return name;
  }

  /** Commit sha of a branch, tag, `heads/x` / `tags/x` / `refs/heads/x` name, or a full sha. */
  async #commitSha(ref: string, signal?: AbortSignal): Promise<string> {
    if (SHA.test(ref)) return ref;
    const name = ref.replace(/^refs\//, '');
    const candidates = /^(heads|tags)\//.test(name) ? [name] : [`heads/${name}`, `tags/${name}`];
    for (const candidate of candidates) {
      const reply = await this.#api('GET', this.#repoPath(`/git/ref/${encPath(candidate)}`), {
        allow: [404],
        signal,
      });
      if (reply.status === 404) continue;
      const object = isRecord(reply.json) && isRecord(reply.json.object) ? reply.json.object : {};
      let sha = text(object.sha);
      if (sha && object.type === 'tag') {
        const tag = await this.#api('GET', this.#repoPath(`/git/tags/${enc(sha)}`), { signal });
        const target = isRecord(tag.json) && isRecord(tag.json.object) ? tag.json.object : {};
        sha = text(target.sha);
      }
      if (sha) return sha;
    }
    throw new GithubError(
      'not_found',
      `There is no branch or tag named ${ref} in ${this.owner}/${this.repo}.`,
      404,
    );
  }

  /** Every entry of the tree at a commit. Falls back to walking folders when GitHub truncates. */
  async #tree(commit: string, signal?: AbortSignal): Promise<Json[]> {
    const whole = await this.#api('GET', this.#repoPath(`/git/trees/${enc(commit)}`), {
      query: { recursive: '1' },
      signal,
    });
    const body = isRecord(whole.json) ? whole.json : {};
    if (body.truncated !== true) return records(body.tree);

    const entries: Json[] = [];
    const queue: { sha: string; prefix: string }[] = [{ sha: commit, prefix: '' }];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const reply = await this.#api('GET', this.#repoPath(`/git/trees/${enc(job.sha)}`), { signal });
        const part = isRecord(reply.json) ? reply.json : {};
        if (part.truncated === true) {
          throw new GithubError(
            'too_large',
            `A folder in ${this.owner}/${this.repo} is too large for GitHub to list.`,
          );
        }
        for (const entry of records(part.tree)) {
          const path = `${job.prefix}${text(entry.path) ?? ''}`;
          entries.push({ ...entry, path });
          const sha = text(entry.sha);
          if (entry.type === 'tree' && sha) queue.push({ sha, prefix: `${path}/` });
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return entries;
  }

  // -------------------------------------------------------------------------------------------
  // RepoConnector

  async listFiles(ref?: string): Promise<string[]> {
    const commit = await this.#commitSha(ref ?? (await this.defaultBranch()));
    const entries = await this.#tree(commit);
    return entries
      .filter((e) => e.type === 'blob')
      .map((e) => text(e.path))
      .filter((p): p is string => p !== undefined)
      .sort();
  }

  async readFile(path: string, ref?: string): Promise<string | undefined> {
    checkRepoPath(path);
    const reply = await this.#api('GET', this.#repoPath(`/contents/${encPath(path)}`), {
      query: { ref },
      allow: [404],
    });
    const body = reply.json;
    if (reply.status === 404) {
      // The same status means "no such file" and "no such ref"; only the first is an answer.
      if (
        /no commit found for the ref/i.test(text(isRecord(body) ? body.message : undefined) ?? '')
      ) {
        throw new GithubError(
          'not_found',
          `There is no branch, tag or commit named ${ref} in ${this.owner}/${this.repo}.`,
          404,
        );
      }
      return undefined;
    }
    if (!isRecord(body) || body.type !== 'file') return undefined; // a folder, symlink or submodule
    const size = num(body.size) ?? 0;
    if (size > this.#maxFileBytes) {
      throw new GithubError(
        'too_large',
        `${path} is ${size} bytes, over the ${this.#maxFileBytes} byte limit.`,
      );
    }
    let content = text(body.content);
    if (body.encoding !== 'base64' || (content === '' && size > 0) || content === undefined) {
      // Over 1 MB the contents API leaves `content` empty. The blob API serves up to 100 MB.
      const sha = text(body.sha);
      if (!sha) throw new GithubError('unexpected', `GitHub gave no content or blob for ${path}.`);
      const blob = await this.#api('GET', this.#repoPath(`/git/blobs/${enc(sha)}`));
      const b = isRecord(blob.json) ? blob.json : {};
      if (b.encoding !== 'base64' || typeof b.content !== 'string') {
        throw new GithubError(
          'unexpected',
          `GitHub returned ${path} in a form that could not be read.`,
        );
      }
      content = b.content;
    }
    try {
      // ignoreBOM keeps a leading BOM, so the text hashes to the same blob it came from.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(content, 'base64'),
      );
    } catch {
      throw new GithubError('not_text', `${path} is not UTF-8 text.`);
    }
  }

  async propose(changeSet: ChangeSet, options: ProposeOptions): Promise<ProposalResult> {
    const branch = checkBranchName(options.branch);
    if (changeSet.target !== 'repo') {
      throw new GithubError(
        'invalid_input',
        `A ${changeSet.target} change set cannot be written to a repository.`,
      );
    }
    const seen = new Set<string>();
    for (const file of changeSet.files) {
      checkRepoPath(file.path);
      if (seen.has(file.path))
        throw new GithubError('invalid_input', `${file.path} appears twice in the change set.`);
      seen.add(file.path);
      if (this.#blocked.some((prefix) => file.path.startsWith(prefix))) {
        throw new GithubError(
          'blocked_path',
          `Refusing to change ${file.path}: that location is not edited by this tool.`,
        );
      }
    }

    const signal = options.signal;
    const base = await this.defaultBranch(signal);
    if (branch.toLowerCase() === base.toLowerCase()) throw new DefaultBranchError(base);

    const baseSha = await this.#commitSha(`heads/${base}`, signal);
    const taken = await this.#api('GET', this.#repoPath(`/git/ref/${encPath(`heads/${branch}`)}`), {
      allow: [404],
      signal,
    });
    if (taken.status !== 404) throw new BranchExistsError(branch);

    const baseCommit = await this.#api('GET', this.#repoPath(`/git/commits/${enc(baseSha)}`), {
      signal,
    });
    const baseTree = text(
      isRecord(baseCommit.json) && isRecord(baseCommit.json.tree)
        ? baseCommit.json.tree.sha
        : undefined,
    );
    if (!baseTree)
      throw new GithubError('unexpected', 'GitHub did not return the tree of the default branch.');

    // Only the entries the change set touches matter, but GitHub offers no partial listing.
    const existing = new Map<string, Json>();
    for (const entry of await this.#tree(baseTree, signal)) {
      const path = text(entry.path);
      if (path !== undefined && seen.has(path)) existing.set(path, entry);
    }
    const plan = this.#plan(changeSet.files, existing);
    if (plan.conflicts.length > 0) throw new ChangeConflictError(plan.conflicts.sort());
    if (plan.changes.length === 0) {
      throw new GithubError(
        'no_changes',
        'Nothing to commit: the repository already matches the change set.',
      );
    }

    // blobs -> tree -> commit -> ref
    const treeEntries: Json[] = [];
    const queue = [...plan.changes];
    const worker = async () => {
      for (let change = queue.shift(); change; change = queue.shift()) {
        if (change.content === undefined) {
          treeEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha: null });
          continue;
        }
        const blob = await this.#api('POST', this.#repoPath('/git/blobs'), {
          body: { content: change.content, encoding: 'utf-8' },
          signal,
        });
        const sha = text(isRecord(blob.json) ? blob.json.sha : undefined);
        if (!sha)
          throw new GithubError('unexpected', `GitHub did not return a blob for ${change.path}.`);
        treeEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    treeEntries.sort((a, b) => ((text(a.path) ?? '') < (text(b.path) ?? '') ? -1 : 1));

    const tree = await this.#api('POST', this.#repoPath('/git/trees'), {
      body: { base_tree: baseTree, tree: treeEntries },
      signal,
    });
    const treeSha = text(isRecord(tree.json) ? tree.json.sha : undefined);
    if (!treeSha) throw new GithubError('unexpected', 'GitHub did not return the new tree.');

    const summary = changeSet.summary.trim();
    const message =
      summary && summary !== options.title ? `${options.title}\n\n${summary}` : options.title;
    const commit = await this.#api('POST', this.#repoPath('/git/commits'), {
      body: { message, tree: treeSha, parents: [baseSha] },
      signal,
    });
    const commitSha = text(isRecord(commit.json) ? commit.json.sha : undefined);
    if (!commitSha) throw new GithubError('unexpected', 'GitHub did not return the new commit.');

    try {
      await this.#api('POST', this.#repoPath('/git/refs'), {
        body: { ref: `refs/heads/${branch}`, sha: commitSha },
        signal,
      });
    } catch (error) {
      // Lost a race for the name between the check above and now.
      if (
        error instanceof GithubError &&
        error.kind === 'validation' &&
        /already exists/i.test(error.message)
      ) {
        throw new BranchExistsError(branch);
      }
      throw error;
    }

    // No signal from here on: the branch exists, and an abort must not leave it without its pull
    // request. This is one request, bounded by the connector's own timeout.
    try {
      const pr = await this.#api('POST', this.#repoPath('/pulls'), {
        body: {
          title: options.title,
          head: branch,
          base,
          body: options.body ?? this.#pullRequestBody(changeSet, plan.changes),
          ...(options.draft ? { draft: true } : {}),
        },
      });
      const json = isRecord(pr.json) ? pr.json : {};
      const url = text(json.html_url);
      const number = num(json.number);
      return {
        branch,
        ...(url ? { url } : {}),
        ...(number !== undefined ? { number } : {}),
        commitSha,
      };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      throw new PullRequestFailedError(branch, commitSha, error);
    }
  }

  /** Compares each change with the tree it will be applied to. */
  #plan(files: FileChange[], existing: Map<string, Json>) {
    type Planned = { path: string; mode: string; content?: string };
    const changes: Planned[] = [];
    const conflicts: string[] = [];
    for (const file of files) {
      const entry = existing.get(file.path);
      const currentSha = text(entry?.sha);
      const mode = text(entry?.mode) ?? '100644';
      if (entry && (entry.type !== 'blob' || mode === '120000' || mode === '160000')) {
        throw new GithubError(
          'invalid_input',
          `${file.path} is a symlink, submodule or folder, which cannot be edited here.`,
        );
      }
      if (file.after === undefined) {
        if (!entry) continue; // already gone
        if (file.before !== undefined && currentSha !== gitBlobSha(file.before))
          conflicts.push(file.path);
        else changes.push({ path: file.path, mode });
        continue;
      }
      const afterSha = gitBlobSha(file.after);
      if (currentSha === afterSha) continue; // already applied
      if (
        file.before === undefined ? entry !== undefined : currentSha !== gitBlobSha(file.before)
      ) {
        conflicts.push(file.path);
        continue;
      }
      changes.push({ path: file.path, mode, content: file.after });
    }
    return { changes, conflicts };
  }

  #pullRequestBody(changeSet: ChangeSet, changes: { path: string; content?: string }[]): string {
    const shown = changes.slice(0, 50).map((c) => `- \`${c.path}\``);
    const more = changes.length > 50 ? [`- and ${changes.length - 50} more`] : [];
    return [
      changeSet.summary.trim(),
      `Changed files (${changes.length}):`,
      [...shown, ...more].join('\n'),
      `Opened by Mobile Release Manager from change set \`${changeSet.id}\`.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<DispatchResult> {
    if (!workflow.trim() || !ref.trim()) {
      throw new GithubError(
        'invalid_input',
        'A workflow and a ref are required to dispatch a workflow.',
      );
    }
    const entries = Object.entries(inputs ?? {});
    if (entries.length > 25) {
      throw new GithubError('invalid_input', 'GitHub accepts at most 25 workflow inputs.');
    }
    const reply = await this.#api(
      'POST',
      this.#repoPath(`/actions/workflows/${enc(workflow)}/dispatches`),
      {
        body: {
          ref,
          ...(entries.length > 0 ? { inputs: Object.fromEntries(entries) } : {}),
          ...(this.#runDetails ? { return_run_details: true } : {}),
        },
      },
    );
    // 204 with no body is the long-standing answer and carries no run id. With run details
    // requested GitHub answers 200 and names the run.
    const json = isRecord(reply.json) ? reply.json : {};
    const id = json.workflow_run_id;
    const runId = typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
    const runUrl = text(json.html_url);
    return { ...(runId ? { runId } : {}), ...(runUrl ? { runUrl } : {}) };
  }

  async listWorkflowRuns(options: ListWorkflowRunsOptions = {}): Promise<WorkflowRun[]> {
    const path = options.workflow
      ? this.#repoPath(`/actions/workflows/${enc(options.workflow)}/runs`)
      : this.#repoPath('/actions/runs');
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), 100);
    const reply = await this.#api('GET', path, {
      query: {
        per_page: String(limit),
        branch: options.branch,
        event: options.event,
        status: options.status,
        head_sha: options.headSha,
      },
    });
    const body = isRecord(reply.json) ? reply.json : {};
    const time = (v: unknown) => {
      const parsed = Date.parse(text(v) ?? '');
      return Number.isNaN(parsed) ? undefined : parsed;
    };
    return records(body.workflow_runs).flatMap((run) => {
      const id = run.id;
      const url = text(run.html_url);
      if ((typeof id !== 'number' && typeof id !== 'string') || !url) return [];
      const out: WorkflowRun = { id: String(id), status: text(run.status) ?? 'unknown', url };
      const set = <K extends keyof WorkflowRun>(
        key: K,
        value: WorkflowRun[K] | undefined | null,
      ) => {
        if (value !== undefined && value !== null) out[key] = value;
      };
      set('name', text(run.name));
      set('conclusion', text(run.conclusion));
      set('branch', text(run.head_branch));
      set('headSha', text(run.head_sha));
      set('event', text(run.event));
      set('runNumber', num(run.run_number));
      set('createdAt', time(run.created_at));
      set('updatedAt', time(run.updated_at));
      return [out];
    });
  }
}
