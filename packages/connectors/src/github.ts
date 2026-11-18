import { createHash, createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { type ChangeSet, checkSecret, type FileChange } from '@mrm/core';
import type { BlobEntry, BlobHeadItem, BlobHeads, BlobHeadsOptions, BlobListing } from './blobs.ts';
import {
  BranchExistsError,
  BranchMissingError,
  BranchMovedError,
  ChangeConflictError,
  DefaultBranchError,
  GithubError,
  GithubRateLimitError,
  PullRequestFailedError,
  redactSecrets,
} from './errors.ts';
import type {
  CommitOnBranchOptions,
  CommitOnBranchResult,
  PullRequestInfo,
  DispatchResult,
  ListWorkflowRunsOptions,
  ProposalResult,
  OpenPullRequestOptions,
  OpenPullRequestResult,
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
  /** Blob listings of the last few commits (see `listBlobEntries`). */
  readonly #blobTrees = new Map<string, Promise<BlobEntry[]>>();

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

  /**
   * A token that authenticates as this connector's credential: the personal access token, or the
   * installation token of the GitHub App (minted on demand, scoped to this repository, cached and
   * renewed before it expires). For code that talks to GitHub by another route than this class,
   * such as git over https (see `GitCloneReader`). Treat it as a secret: never log it. It is
   * already known to this connector's redaction.
   */
  async installationToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new GithubError('network', 'The request was cancelled.');
    return this.#installationToken();
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

  /**
   * The commit a branch or tag points to right now (default: the default branch). A caller that
   * passes it back as `ref` to `listFiles` and `readFile` reads one consistent snapshot, and can
   * cache by it: a commit never changes.
   */
  async resolveCommit(ref?: string, signal?: AbortSignal): Promise<string> {
    return this.#commitSha(ref ?? (await this.defaultBranch(signal)), signal);
  }

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

  // -------------------------------------------------------------------------------------------
  // Binary files, bounded (see blobs.ts). Additive: `readFile` above is for text.

  /** Every file of a commit with its blob sha and size (the tree gives both). Symlinks are left out. */
  async listBlobEntries(ref?: string, options: { signal?: AbortSignal } = {}): Promise<BlobListing> {
    const commit = await this.#commitSha(ref ?? (await this.defaultBranch(options.signal)), options.signal);
    let pending = this.#blobTrees.get(commit);
    if (!pending) {
      pending = this.#tree(commit, options.signal).then((entries) =>
        entries
          .filter((e) => e.type === 'blob' && e.mode !== '120000')
          .flatMap((e): BlobEntry[] => {
            const path = text(e.path);
            const oid = text(e.sha);
            return path && oid ? [{ path, oid, mode: text(e.mode) ?? '100644', size: num(e.size) ?? null }] : [];
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      );
      pending.catch(() => this.#blobTrees.delete(commit));
      this.#blobTrees.set(commit, pending);
      while (this.#blobTrees.size > 4) {
        const oldest = this.#blobTrees.keys().next().value;
        if (oldest === undefined) break;
        this.#blobTrees.delete(oldest);
      }
    }
    return { commit, entries: await pending };
  }

  /**
   * The first `headBytes` bytes of each path. The REST API has no range read, so a file is pulled
   * whole (`/git/blobs/<sha>`, base64) and its size is taken from the tree beforehand: a file over
   * `maxFileBytes` is not requested, and once the sizes of the files already planned add up to
   * `maxTransferBytes` the rest is `budget`. A file the API cannot serve is `missing`; a rate limit,
   * an authorisation failure or a network failure stops the whole call.
   */
  async readBlobHeads(paths: readonly string[], options: BlobHeadsOptions): Promise<BlobHeads> {
    const signal = options.signal;
    const { entries } = await this.listBlobEntries(options.ref, signal ? { signal } : {});
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const items = new Map<string, BlobHeadItem>();
    const plan: BlobEntry[] = [];
    let reserved = 0;
    for (const path of paths) {
      if (items.has(path) || plan.some((p) => p.path === path)) continue;
      const entry = byPath.get(path);
      if (!entry) items.set(path, { ok: false, oid: null, reason: 'missing', size: null });
      else if (entry.size !== null && entry.size > options.maxFileBytes) {
        items.set(path, { ok: false, oid: entry.oid, reason: 'too_large', size: entry.size });
      } else if (options.headBytes > 0 && reserved + (entry.size ?? 0) > options.maxTransferBytes) {
        items.set(path, { ok: false, oid: entry.oid, reason: 'budget', size: entry.size });
      } else {
        plan.push(entry);
        reserved += entry.size ?? 0;
      }
    }
    let transferred = 0;
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < plan.length; i = next++) {
        const entry = plan[i] as BlobEntry;
        if (options.headBytes <= 0) {
          // Sizes only: the tree has them, nothing is downloaded.
          items.set(
            entry.path,
            entry.size === null
              ? { ok: false, oid: entry.oid, reason: 'unsized', size: null }
              : { ok: true, oid: entry.oid, size: entry.size, head: new Uint8Array(0) },
          );
          continue;
        }
        try {
          const reply = await this.#api('GET', this.#repoPath(`/git/blobs/${enc(entry.oid)}`), signal ? { signal } : {});
          const body = isRecord(reply.json) ? reply.json : {};
          if (body.encoding !== 'base64' || typeof body.content !== 'string') {
            items.set(entry.path, { ok: false, oid: entry.oid, reason: 'missing', size: entry.size });
            continue;
          }
          const bytes = Buffer.from(body.content, 'base64');
          transferred += bytes.length;
          items.set(
            entry.path,
            bytes.length > options.maxFileBytes
              ? { ok: false, oid: entry.oid, reason: 'too_large', size: bytes.length }
              : { ok: true, oid: entry.oid, size: bytes.length, head: new Uint8Array(bytes.subarray(0, options.headBytes)) },
          );
        } catch (error) {
          const fatal =
            error instanceof GithubRateLimitError ||
            (error instanceof GithubError && ['auth', 'forbidden', 'network', 'server'].includes(error.kind)) ||
            !(error instanceof GithubError);
          if (fatal) throw error;
          items.set(entry.path, { ok: false, oid: entry.oid, reason: 'missing', size: entry.size });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, plan.length) }, worker));
    return { items, transferredBytes: transferred };
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
      const pr = await this.openPullRequest({
        branch,
        base,
        title: options.title,
        body: options.body ?? this.#pullRequestBody(changeSet, plan.changes),
        ...(options.draft ? { draft: true } : {}),
      });
      return {
        branch,
        ...(pr.url ? { url: pr.url } : {}),
        ...(pr.number !== undefined ? { number: pr.number } : {}),
        commitSha,
      };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      throw new PullRequestFailedError(branch, commitSha, error);
    }
  }

  /**
   * Opens a pull request from `branch` into `base`. The branch must exist on GitHub (`propose` has
   * just made it, or a local commit was pushed). One request; the signal, when given, cancels it.
   */
  async openPullRequest(options: OpenPullRequestOptions): Promise<OpenPullRequestResult> {
    const head = checkBranchName(options.branch);
    const base = checkBranchName(options.base);
    const pr = await this.#api('POST', this.#repoPath('/pulls'), {
      body: {
        title: options.title,
        head,
        base,
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.draft ? { draft: true } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const json = isRecord(pr.json) ? pr.json : {};
    const url = text(json.html_url);
    const number = num(json.number);
    return { ...(url ? { url } : {}), ...(number !== undefined ? { number } : {}) };
  }

  // -------------------------------------------------------------------------------------------
  // Fix-up: one more commit on a branch that exists (never a rewrite, never forced)

  /** The commit a branch points to now, or undefined when GitHub has no such branch. */
  async branchTip(branch: string, signal?: AbortSignal): Promise<string | undefined> {
    checkBranchName(branch);
    const reply = await this.#api('GET', this.#repoPath(`/git/ref/${encPath(`heads/${branch}`)}`), {
      allow: [404],
      ...(signal ? { signal } : {}),
    });
    if (reply.status === 404) return undefined;
    const object = isRecord(reply.json) && isRecord(reply.json.object) ? reply.json.object : {};
    return text(object.sha);
  }

  /** A pull request by number, or the newest one (open first) whose head is `branch`. */
  async findPullRequest(
    options: { number?: number; branch?: string; signal?: AbortSignal } = {},
  ): Promise<PullRequestInfo | undefined> {
    const info = (json: Json): PullRequestInfo | undefined => {
      const number = num(json.number);
      if (number === undefined) return undefined;
      const state = text(json.state) === 'open' ? 'open' : json.merged === true || text(json.merged_at) ? 'merged' : 'closed';
      const head = isRecord(json.head) ? text(json.head.ref) : undefined;
      const base = isRecord(json.base) ? text(json.base.ref) : undefined;
      const url = text(json.html_url);
      return { number, state, ...(url ? { url } : {}), ...(head ? { branch: head } : {}), ...(base ? { base } : {}) };
    };
    const signal = options.signal ? { signal: options.signal } : {};
    if (options.number !== undefined) {
      const reply = await this.#api('GET', this.#repoPath(`/pulls/${enc(String(options.number))}`), { allow: [404], ...signal });
      return reply.status === 404 || !isRecord(reply.json) ? undefined : info(reply.json);
    }
    if (options.branch === undefined) return undefined;
    const branch = checkBranchName(options.branch);
    const reply = await this.#api('GET', this.#repoPath('/pulls'), {
      query: { head: `${this.owner}:${branch}`, state: 'all', sort: 'created', direction: 'desc', per_page: '10' },
      ...signal,
    });
    const found = records(reply.json)
      .map(info)
      .filter((p): p is PullRequestInfo => p !== undefined);
    return found.find((p) => p.state === 'open') ?? found[0];
  }

  /**
   * One commit on top of `expectedTip`, on the existing branch `branch`: blobs, a tree built on the
   * tip's tree, a commit whose only parent is the tip, then the ref moved with `force: false`. The
   * default branch is refused, as `propose` does. A branch that is not at `expectedTip`, or a ref
   * update GitHub refuses as not a fast-forward, is a `BranchMovedError`; nothing is forced. Files
   * that already have the text are skipped; if none is left it is a `no_changes` error.
   */
  async commitOnBranch(options: CommitOnBranchOptions): Promise<CommitOnBranchResult> {
    const branch = checkBranchName(options.branch);
    const seen = new Set<string>();
    for (const change of options.changes) {
      checkRepoPath(change.path);
      if (seen.has(change.path)) {
        throw new GithubError('invalid_input', `${change.path} appears twice in the change.`);
      }
      seen.add(change.path);
      if (this.#blocked.some((prefix) => change.path.startsWith(prefix))) {
        throw new GithubError(
          'blocked_path',
          `Refusing to change ${change.path}: that location is not edited by this tool.`,
        );
      }
    }
    const signal = options.signal;
    const base = await this.defaultBranch(signal);
    if (branch.toLowerCase() === base.toLowerCase()) throw new DefaultBranchError(base);

    const tip = await this.branchTip(branch, signal);
    if (tip === undefined) throw new BranchMissingError(branch);
    if (tip !== options.expectedTip) throw new BranchMovedError(branch);

    const tipCommit = await this.#api('GET', this.#repoPath(`/git/commits/${enc(tip)}`), {
      ...(signal ? { signal } : {}),
    });
    const tipTree = text(
      isRecord(tipCommit.json) && isRecord(tipCommit.json.tree) ? tipCommit.json.tree.sha : undefined,
    );
    if (!tipTree) throw new GithubError('unexpected', 'GitHub did not return the tree of the branch.');
    const existing = new Map<string, Json>();
    for (const entry of await this.#tree(tipTree, signal)) {
      const path = text(entry.path);
      if (path !== undefined && seen.has(path)) existing.set(path, entry);
    }

    const planned: { path: string; mode: string; content?: string }[] = [];
    for (const change of options.changes) {
      const entry = existing.get(change.path);
      const mode = text(entry?.mode) ?? '100644';
      if (entry && (entry.type !== 'blob' || mode === '120000' || mode === '160000')) {
        throw new GithubError(
          'invalid_input',
          `${change.path} is a symlink, submodule or folder, which cannot be edited here.`,
        );
      }
      if (change.content === undefined) {
        if (entry) planned.push({ path: change.path, mode });
        continue;
      }
      if (text(entry?.sha) === gitBlobSha(change.content)) continue;
      planned.push({ path: change.path, mode, content: change.content });
    }
    if (planned.length === 0) {
      throw new GithubError('no_changes', 'Nothing to commit: the branch already has these files.');
    }

    const treeEntries: Json[] = [];
    const queue = [...planned];
    const worker = async () => {
      for (let change = queue.shift(); change; change = queue.shift()) {
        if (change.content === undefined) {
          treeEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha: null });
          continue;
        }
        const blob = await this.#api('POST', this.#repoPath('/git/blobs'), {
          body: { content: change.content, encoding: 'utf-8' },
          ...(signal ? { signal } : {}),
        });
        const sha = text(isRecord(blob.json) ? blob.json.sha : undefined);
        if (!sha) throw new GithubError('unexpected', `GitHub did not return a blob for ${change.path}.`);
        treeEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    treeEntries.sort((a, b) => ((text(a.path) ?? '') < (text(b.path) ?? '') ? -1 : 1));

    const tree = await this.#api('POST', this.#repoPath('/git/trees'), {
      body: { base_tree: tipTree, tree: treeEntries },
      ...(signal ? { signal } : {}),
    });
    const treeSha = text(isRecord(tree.json) ? tree.json.sha : undefined);
    if (!treeSha) throw new GithubError('unexpected', 'GitHub did not return the new tree.');
    const commit = await this.#api('POST', this.#repoPath('/git/commits'), {
      body: { message: options.message, tree: treeSha, parents: [tip] },
      ...(signal ? { signal } : {}),
    });
    const commitSha = text(isRecord(commit.json) ? commit.json.sha : undefined);
    if (!commitSha) throw new GithubError('unexpected', 'GitHub did not return the new commit.');

    try {
      // `force: false` is GitHub's default; it is sent so that this can only ever be a fast-forward.
      await this.#api('PATCH', this.#repoPath(`/git/refs/${encPath(`heads/${branch}`)}`), {
        body: { sha: commitSha, force: false },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof GithubError && error.kind === 'validation') throw new BranchMovedError(branch);
      throw error;
    }
    return { commit: commitSha, parent: tip, tree: treeSha, changed: planned.length };
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

  // -------------------------------------------------------------------------------------------
  // CI reads: workflows, runs with their details, and comparing two commits. Read-only.

  /** The workflows of the repository (up to 100), by path. */
  async listWorkflows(signal?: AbortSignal): Promise<CiWorkflow[]> {
    const reply = await this.#api('GET', this.#repoPath('/actions/workflows'), {
      query: { per_page: '100' },
      signal,
    });
    const body = isRecord(reply.json) ? reply.json : {};
    return records(body.workflows)
      .flatMap((w) => {
        const id = w.id;
        const path = text(w.path);
        if ((typeof id !== 'number' && typeof id !== 'string') || !path) return [];
        const out: CiWorkflow = {
          id: String(id),
          name: text(w.name) ?? path,
          path,
          state: text(w.state) ?? 'unknown',
        };
        const url = text(w.html_url);
        if (url) out.url = url;
        return [out];
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Like `listWorkflowRuns`, with the extra fields CI tracking needs (run title, workflow path,
   * start time, commit message), and a cancellable request.
   */
  async listCiRuns(
    options: ListWorkflowRunsOptions & { signal?: AbortSignal } = {},
  ): Promise<CiRun[]> {
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
      signal: options.signal,
    });
    const body = isRecord(reply.json) ? reply.json : {};
    return records(body.workflow_runs).flatMap((run) => {
      const mapped = mapCiRun(run);
      return mapped ? [mapped] : [];
    });
  }

  /** One workflow run, or undefined when GitHub has no such run (any more). */
  async getCiRun(runId: string, signal?: AbortSignal): Promise<CiRun | undefined> {
    if (!/^[0-9]{1,20}$/.test(runId)) {
      throw new GithubError('invalid_input', `Not a workflow run id: ${JSON.stringify(runId)}.`);
    }
    const reply = await this.#api('GET', this.#repoPath(`/actions/runs/${runId}`), {
      allow: [404],
      signal,
    });
    if (reply.status === 404 || !isRecord(reply.json)) return undefined;
    return mapCiRun(reply.json);
  }

  /**
   * The commits between two commits, branches or tags (what `head` has that `base` does not).
   * `commits` are oldest first, as GitHub sends them. When there are more than `limit` (at most
   * 100, the default), the newest `limit` are returned and `truncated` is true.
   */
  async compareCommits(
    base: string,
    head: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CommitComparison> {
    checkBranchName(base);
    checkBranchName(head);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100);
    const path = this.#repoPath(`/compare/${encPath(base)}...${encPath(head)}`);
    const page = async (n: number) => {
      const reply = await this.#api('GET', path, {
        query: { per_page: '100', page: String(n) },
        signal: options.signal,
      });
      return isRecord(reply.json) ? reply.json : {};
    };
    const first = await page(1);
    const total = num(first.total_commits) ?? records(first.commits).length;
    const pages = Math.max(1, Math.ceil(total / 100));
    let commits = records(first.commits).flatMap(mapCommit);
    if (pages > 1) {
      // Commits are oldest first, so the newest ones are on the last page(s).
      const last = records((await page(pages)).commits).flatMap(mapCommit);
      commits = last;
      if (last.length < limit) {
        commits = [...records((await page(pages - 1)).commits).flatMap(mapCommit), ...last];
      }
    }
    if (commits.length > limit) commits = commits.slice(commits.length - limit);
    const out: CommitComparison = {
      status: text(first.status) ?? 'unknown',
      aheadBy: num(first.ahead_by) ?? 0,
      behindBy: num(first.behind_by) ?? 0,
      totalCommits: total,
      commits,
      truncated: total > commits.length,
    };
    const url = text(first.html_url);
    if (url) out.url = url;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Tags, releases and single commits. Read-only. They let a build number be followed to the
  // tag a release lane creates, and from the tag's commit to the run that made it.

  /**
   * The tags of the repository with the commit each one points to (`GET /repos/{r}/tags`, 100 per
   * page). GitHub's order is not documented, so at most `maxPages` pages (default 5, at most 10)
   * are read: `truncated` says when a repository has more tags than that. The commit is the one
   * GitHub reports for the tag (not checked against live GitHub for annotated tags; see
   * `listMatchingTags`, which resolves them itself).
   */
  async listTags(options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<TagList> {
    const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 5), 1), 10);
    const tags: GitTag[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const reply = await this.#api('GET', this.#repoPath('/tags'), {
        query: { per_page: '100', page: String(page) },
        signal: options.signal,
      });
      const items = records(reply.json);
      for (const item of items) {
        const name = text(item.name);
        const commit = isRecord(item.commit) ? item.commit : {};
        const sha = text(commit.sha);
        if (name && name.length <= 250 && sha && SHA.test(sha)) tags.push({ name, sha: sha.toLowerCase() });
      }
      if (items.length < 100) return { tags, truncated: false, pages: page };
    }
    return { tags, truncated: true, pages: maxPages };
  }

  /**
   * Tags whose name starts with `prefix` (`GET /repos/{r}/git/matching-refs/tags/{prefix}`; GitHub
   * documents no paging for it). An annotated tag is followed to its commit through
   * `GET /git/tags/{sha}`, at most `resolveLimit` (default 50) of them; later ones are counted in
   * `unresolved` and left out. At most `limit` tags (default 500) are returned.
   */
  async listMatchingTags(
    prefix: string,
    options: { limit?: number; resolveLimit?: number; signal?: AbortSignal } = {},
  ): Promise<TagList & { unresolved: number }> {
    if (
      prefix.length > 200 ||
      prefix.split('/').some((s) => s === '.' || s === '..') ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters
      /[\x00-\x1f\x7f\\]/.test(prefix)
    ) {
      throw new GithubError('invalid_input', `Not a valid tag prefix: ${JSON.stringify(prefix)}.`);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 1000);
    let budget = Math.min(Math.max(Math.trunc(options.resolveLimit ?? 50), 0), 200);
    const reply = await this.#api('GET', this.#repoPath(`/git/matching-refs/tags/${encPath(prefix)}`), {
      signal: options.signal,
    });
    const items = records(reply.json);
    const tags: GitTag[] = [];
    let unresolved = 0;
    for (const item of items) {
      const refName = text(item.ref);
      if (!refName?.startsWith('refs/tags/')) continue;
      const name = refName.slice('refs/tags/'.length);
      let object = isRecord(item.object) ? item.object : {};
      let sha = text(object.sha);
      let kind = text(object.type);
      let annotated = false;
      // An annotated tag is its own object that points at the commit (or at another tag).
      for (let depth = 0; kind === 'tag' && sha && depth < 3; depth++) {
        annotated = true;
        if (budget <= 0) {
          sha = undefined;
          break;
        }
        budget--;
        const tagReply = await this.#api('GET', this.#repoPath(`/git/tags/${enc(sha)}`), {
          signal: options.signal,
        });
        object = isRecord(tagReply.json) && isRecord(tagReply.json.object) ? tagReply.json.object : {};
        sha = text(object.sha);
        kind = text(object.type);
      }
      if (!name || !sha || kind !== 'commit' || !SHA.test(sha)) {
        if (annotated) unresolved++;
        continue;
      }
      if (tags.length >= limit) return { tags, truncated: true, pages: 1, unresolved };
      tags.push(annotated ? { name, sha: sha.toLowerCase(), annotated } : { name, sha: sha.toLowerCase() });
    }
    return { tags, truncated: false, pages: 1, unresolved };
  }

  /**
   * One commit with its parents (`GET /repos/{r}/commits/{ref}`), or undefined when GitHub has no
   * such commit. `ref` is a sha, a branch or a tag name. The file list is not wanted: one file per
   * page is asked for, which GitHub documents as the page size of that list.
   */
  async getCommit(ref: string, signal?: AbortSignal): Promise<CommitDetail | undefined> {
    if (!SHA.test(ref)) checkBranchName(ref);
    const reply = await this.#api('GET', this.#repoPath(`/commits/${encPath(ref)}`), {
      query: { per_page: '1' },
      allow: [404, 422],
      signal,
    });
    if (reply.status === 404 || reply.status === 422 || !isRecord(reply.json)) return undefined;
    const [base] = mapCommit(reply.json);
    if (!base) return undefined;
    const commit = isRecord(reply.json.commit) ? reply.json.commit : {};
    const committer = isRecord(commit.committer) ? commit.committer : {};
    const out: CommitDetail = {
      ...base,
      parents: records(reply.json.parents).flatMap((p) => {
        const sha = text(p.sha);
        return sha && SHA.test(sha) ? [sha.toLowerCase()] : [];
      }),
    };
    const committedAt = isoTime(committer.date);
    if (committedAt !== undefined) out.committedAt = committedAt;
    return out;
  }

  /**
   * The releases of the repository (`GET /repos/{r}/releases`, 100 per page, at most `maxPages`:
   * default 3, at most 10). Drafts are kept and marked, because they have no tag yet.
   */
  async listReleases(options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<ReleaseList> {
    const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 3), 1), 10);
    const releases: GitRelease[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const reply = await this.#api('GET', this.#repoPath('/releases'), {
        query: { per_page: '100', page: String(page) },
        signal: options.signal,
      });
      const items = records(reply.json);
      for (const item of items) {
        const tagName = text(item.tag_name);
        const id = item.id;
        if (!tagName || (typeof id !== 'number' && typeof id !== 'string')) continue;
        const out: GitRelease = {
          id: String(id),
          tagName,
          draft: item.draft === true,
          prerelease: item.prerelease === true,
        };
        const name = text(item.name);
        if (name) out.name = name;
        const target = text(item.target_commitish);
        if (target) out.targetCommitish = target;
        const created = isoTime(item.created_at);
        if (created !== undefined) out.createdAt = created;
        const published = isoTime(item.published_at);
        if (published !== undefined) out.publishedAt = published;
        const url = text(item.html_url);
        if (url) out.url = url;
        releases.push(out);
      }
      if (items.length < 100) return { releases, truncated: false, pages: page };
    }
    return { releases, truncated: true, pages: maxPages };
  }
}

/** A workflow of a repository, as `GET /actions/workflows` lists it. */
export type CiWorkflow = {
  id: string;
  name: string;
  /** For example `.github/workflows/release.yml`. */
  path: string;
  /** GitHub's own state: `active`, `disabled_manually`, ... */
  state: string;
  url?: string;
};

/** A workflow run with the fields that CI tracking and build linking use. */
export type CiRun = WorkflowRun & {
  /** The run title: the `run-name` of the workflow, else the commit or pull request title. */
  displayTitle?: string;
  /** The workflow file, for example `.github/workflows/release.yml`. */
  path?: string;
  workflowId?: string;
  /** Epoch milliseconds the run (this attempt) started. */
  startedAt?: number;
  attempt?: number;
  actor?: string;
  /** The message of the commit the run is for, as GitHub reports it (can be several lines). */
  commitMessage?: string;
};

export type CommitInfo = {
  sha: string;
  /** The whole commit message. */
  message: string;
  author?: string;
  /** Epoch milliseconds. */
  date?: number;
  url?: string;
};

export type CommitComparison = {
  /** `ahead`, `behind`, `identical` or `diverged` (GitHub's words, kept verbatim). */
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** Oldest first. At most the requested limit: the newest ones when there are more. */
  commits: CommitInfo[];
  truncated: boolean;
  url?: string;
};

/** A tag and the commit it points to. */
export type GitTag = {
  name: string;
  /** The commit (an annotated tag is followed to it), lower case. */
  sha: string;
  /** True when the tag is an annotated tag object, not a plain ref to a commit. */
  annotated?: boolean;
};

export type TagList = {
  tags: GitTag[];
  /** There may be more tags than were read (page limit reached). */
  truncated: boolean;
  /** How many pages were read. */
  pages: number;
};

/** A commit with its parents, as `GET /commits/{ref}` reports it. */
export type CommitDetail = CommitInfo & {
  /** Parent commit shas, first parent first. */
  parents: string[];
  /** Epoch milliseconds the commit was committed (`date` is when it was authored). */
  committedAt?: number;
};

export type GitRelease = {
  id: string;
  name?: string;
  tagName: string;
  /** A branch name or a commit sha, as the release was created. */
  targetCommitish?: string;
  draft: boolean;
  prerelease: boolean;
  /** Epoch milliseconds. */
  createdAt?: number;
  publishedAt?: number;
  url?: string;
};

export type ReleaseList = { releases: GitRelease[]; truncated: boolean; pages: number };

const isoTime = (v: unknown): number | undefined => {
  const parsed = Date.parse(text(v) ?? '');
  return Number.isNaN(parsed) ? undefined : parsed;
};

function mapCommit(entry: Json): CommitInfo[] {
  const sha = text(entry.sha);
  if (!sha) return [];
  const commit = isRecord(entry.commit) ? entry.commit : {};
  const author = isRecord(commit.author) ? commit.author : {};
  const out: CommitInfo = { sha, message: text(commit.message) ?? '' };
  const name = text(author.name);
  if (name) out.author = name;
  const date = isoTime(author.date);
  if (date !== undefined) out.date = date;
  const url = text(entry.html_url);
  if (url) out.url = url;
  return [out];
}

function mapCiRun(run: Json): CiRun | undefined {
  const id = run.id;
  const url = text(run.html_url);
  if ((typeof id !== 'number' && typeof id !== 'string') || !url) return undefined;
  const out: CiRun = { id: String(id), status: text(run.status) ?? 'unknown', url };
  const set = <K extends keyof CiRun>(key: K, value: CiRun[K] | undefined | null) => {
    if (value !== undefined && value !== null) out[key] = value;
  };
  const workflowId = run.workflow_id;
  const head = isRecord(run.head_commit) ? run.head_commit : {};
  const actor = isRecord(run.actor) ? run.actor : {};
  set('name', text(run.name));
  set('conclusion', text(run.conclusion));
  set('branch', text(run.head_branch));
  set('headSha', text(run.head_sha));
  set('event', text(run.event));
  set('runNumber', num(run.run_number));
  set('createdAt', isoTime(run.created_at));
  set('updatedAt', isoTime(run.updated_at));
  set('displayTitle', text(run.display_title));
  set('path', text(run.path));
  set(
    'workflowId',
    typeof workflowId === 'number' || typeof workflowId === 'string' ? String(workflowId) : undefined,
  );
  set('startedAt', isoTime(run.run_started_at));
  set('attempt', num(run.run_attempt));
  set('actor', text(actor.login));
  set('commitMessage', text(head.message));
  return out;
}
