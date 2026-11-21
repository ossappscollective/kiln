import { createPrivateKey } from 'node:crypto';
import { checkSecret } from '@kiln/core';
import { redactSecrets, secretStrings } from '../errors.ts';
import type { VerifyOptions, VerifyResult } from '../verify.ts';
import { signGithubAppJwt } from './github.ts';

/**
 * "Test connection" for GitHub credentials. Read-only: the one write is the short-lived
 * installation token for an App, which is revoked again when the check is done.
 *
 * Never throws. Every failure is a VerifyResult with a sentence that says what to fix, and no
 * message or detail carries the key, a token or a JWT (see `redactSecrets`).
 */

export type GithubVerifyOptions = VerifyOptions & {
  /** Defaults to https://api.github.com. Set it for GitHub Enterprise Server. */
  apiBase?: string;
  /** Per request. Default 10000. */
  timeoutMs?: number;
  userAgent?: string;
};

type Json = Record<string, unknown>;
type Reply = { status: number; headers: Headers; json: Json };

const API_VERSION = '2022-11-28';
const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Thrown inside this file only, and turned into a VerifyResult before leaving it. */
class Stop extends Error {
  readonly result: VerifyResult;
  constructor(message: string, details?: string[]) {
    super(message);
    this.result = { ok: false, message, ...(details ? { details } : {}) };
  }
}

class Client {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly known = new Set<string>();

  constructor(options: GithubVerifyOptions, known: string[]) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#userAgent = options.userAgent ?? 'kiln';
    this.#now = options.now ?? Date.now;
    for (const value of known) this.known.add(value);
  }

  now() {
    return this.#now();
  }

  redact(value: string): string {
    return redactSecrets(value, this.known);
  }

  async send(method: string, path: string, bearer: string, query?: Json): Promise<Reply> {
    const url = new URL(`${this.#base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${bearer}`,
          'x-github-api-version': API_VERSION,
          'user-agent': this.#userAgent,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Stop('GitHub did not answer in time. Try again in a minute.');
      }
      throw new Stop(
        'Could not reach GitHub. Check that this server has internet access (and a proxy, if it needs one), then try again.',
        [`Network error: ${name}`],
      );
    }
    const raw = await response.text().catch(() => '');
    let json: Json = {};
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (isRecord(parsed)) json = parsed;
    } catch {
      // Not JSON: treat as an empty body.
    }
    return { status: response.status, headers: response.headers, json };
  }

  /** A sentence for a response we have no specific advice for. */
  describe(reply: Reply, doing: string): string {
    const { status, headers } = reply;
    const remaining = headers.get('x-ratelimit-remaining');
    const retryAfter = headers.get('retry-after');
    const message = text(reply.json.message) ?? '';
    if (
      status === 429 ||
      (status === 403 && (remaining === '0' || retryAfter !== null || /rate limit/i.test(message)))
    ) {
      const reset = Number(headers.get('x-ratelimit-reset'));
      const wait = Number(retryAfter);
      let seconds = 60;
      if (retryAfter !== null && Number.isFinite(wait)) seconds = Math.ceil(wait);
      else if (Number.isFinite(reset) && reset > 0) {
        seconds = Math.max(1, Math.ceil((reset * 1000 - this.#now()) / 1000));
      }
      return `GitHub's rate limit has been reached. Try again in ${seconds} seconds.`;
    }
    if (status >= 500) return `GitHub had a problem (HTTP ${status}). Try again in a few minutes.`;
    const why = this.redact(message).slice(0, 200);
    return `GitHub refused ${doing} (HTTP ${status}${why ? `: ${why}` : ''}).`;
  }
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------------------------
// GitHub App

/** What the tool does with an installation. `write` means read and write. */
const APP_PERMISSIONS: { name: string; label: string; why: string }[] = [
  { name: 'contents', label: 'Contents', why: 'to read files and push branches' },
  { name: 'pull_requests', label: 'Pull requests', why: 'to open pull requests' },
  { name: 'actions', label: 'Actions', why: 'to start and read workflow runs' },
];

export async function verifyGithubAppCredential(
  secret: string,
  options: GithubVerifyOptions = {},
): Promise<VerifyResult> {
  const problem = checkSecret('github_app', secret);
  if (problem) return { ok: false, message: problem };
  const parsed = JSON.parse(secret) as Record<string, string>;
  const appId = (parsed.appId ?? '').trim();
  const installationId = (parsed.installationId ?? '').trim();
  const privateKey = parsed.privateKey ?? '';
  const client = new Client(options, secretStrings(secret));
  try {
    return await checkApp(client, appId, installationId, privateKey);
  } catch (error) {
    if (error instanceof Stop) return error.result;
    return { ok: false, message: 'The GitHub App could not be checked. Try again.' };
  }
}

async function checkApp(
  client: Client,
  appId: string,
  installationId: string,
  privateKey: string,
): Promise<VerifyResult> {
  if (!/^\d+$/.test(appId)) {
    throw new Stop(
      "The App ID must be a number. It is shown at the top of the app's settings page.",
    );
  }
  if (!/^\d+$/.test(installationId)) {
    throw new Stop(
      "The installation ID must be a number. It is the last part of the address of the app's installation page on GitHub.",
    );
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    // Never include the node error: some versions echo parts of the input.
    throw new Stop(
      "The private key could not be read. Paste the whole .pem file the app's settings page gave you, including the BEGIN and END lines.",
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Stop(
      "The private key is not an RSA key. Generate a private key on the app's settings page.",
    );
  }
  const jwt = signGithubAppJwt(key, appId, client.now());
  client.known.add(jwt);

  // 1. The app itself.
  const app = await client.send('GET', '/app', jwt);
  if (app.status === 401) {
    const date = Date.parse(app.headers.get('date') ?? '');
    const drift = Number.isNaN(date) ? 0 : Math.abs(client.now() - date);
    throw new Stop(
      drift > 60_000
        ? "GitHub rejected the app's credentials, and this server's clock is off by more than a minute. Fix the clock, then try again."
        : "The private key does not match the app, or the App ID is wrong. Check both on the app's settings page, and create a new private key if unsure.",
    );
  }
  if (app.status >= 400) throw new Stop(client.describe(app, 'the app lookup'));
  const appName = text(app.json.name) ?? text(app.json.slug) ?? `app ${appId}`;
  if (app.json.id !== undefined && String(app.json.id) !== appId) {
    throw new Stop(
      `The App ID does not match the private key: the key belongs to app ${String(app.json.id)}.`,
    );
  }

  // 2. The installation.
  const installation = await client.send('GET', `/app/installations/${installationId}`, jwt);
  if (installation.status === 404) {
    throw new Stop(
      'The installation ID does not belong to this app. Open the installation on GitHub (Settings, Applications, Configure); the number at the end of its address is the installation ID.',
      [`App: ${appName}`],
    );
  }
  if (installation.status >= 400) {
    throw new Stop(client.describe(installation, 'the installation lookup'), [`App: ${appName}`]);
  }
  const account = isRecord(installation.json.account) ? installation.json.account : {};
  const login = text(account.login) ?? 'the account';
  if (installation.json.suspended_at) {
    throw new Stop(
      `The installation on ${login} is suspended. Unsuspend it in the account's installed apps settings on GitHub.`,
      [`App: ${appName}`],
    );
  }
  const granted = isRecord(installation.json.permissions) ? installation.json.permissions : {};
  const warnings: string[] = [];
  for (const { name, label, why } of APP_PERMISSIONS) {
    const level = granted[name];
    if (level === 'write' || level === 'admin') continue;
    warnings.push(
      level === 'read'
        ? `${label} is read-only. Give the app "Read and write" access to ${label} ${why}.`
        : `The app has no ${label} permission. Give it "Read and write" access to ${label} ${why}.`,
    );
  }

  // 3. What the installation can see. This mints an installation token, which is revoked below.
  const mint = await client.send('POST', `/app/installations/${installationId}/access_tokens`, jwt);
  if (mint.status >= 400) {
    const fix =
      mint.status === 401 || mint.status === 403
        ? 'GitHub would not issue an installation token. Check the app is not suspended and has the permissions above.'
        : client.describe(mint, 'the installation token');
    throw new Stop(fix, [`App: ${appName}`]);
  }
  const token = text(mint.json.token);
  if (!token)
    throw new Stop('GitHub returned an installation token response that could not be read.');
  client.known.add(token);
  let repositories: number | undefined;
  try {
    const list = await client.send('GET', '/installation/repositories', token, { per_page: 1 });
    if (list.status < 400 && typeof list.json.total_count === 'number') {
      repositories = list.json.total_count;
    } else if (list.status >= 400) {
      throw new Stop(client.describe(list, 'the repository list'), [`App: ${appName}`]);
    }
  } finally {
    // Best effort: a failure here only means the token lives out its hour.
    await client.send('DELETE', '/installation/token', token).catch(() => undefined);
  }

  const selection = text(installation.json.repository_selection);
  const details = [
    `App: ${appName}`,
    `Installed on: ${login}`,
    ...(selection
      ? [`Repository access: ${selection === 'all' ? 'all repositories' : 'selected repositories'}`]
      : []),
    ...(repositories !== undefined ? [`Repositories it can see: ${repositories}`] : []),
  ];
  if (repositories === 0) {
    warnings.push(
      'The installation has no repositories. Add the repositories you want to manage on the installation page on GitHub.',
    );
  }
  details.push(...warnings.map((w) => `Warning: ${w}`));
  const sees =
    repositories === undefined
      ? ''
      : ` It can see ${plural(repositories, 'repository', 'repositories')}.`;
  return {
    ok: true,
    message: `Connected to the GitHub App "${appName}" on ${login}.${sees}${
      warnings.length
        ? ` ${plural(warnings.length, 'permission or setup issue needs', 'permission or setup issues need')} attention.`
        : ''
    }`,
    details,
  };
}

// ---------------------------------------------------------------------------------------------
// Personal access token

export async function verifyGithubTokenCredential(
  secret: string,
  options: GithubVerifyOptions = {},
): Promise<VerifyResult> {
  const problem = checkSecret('github_token', secret);
  if (problem) return { ok: false, message: problem };
  const token = secret.trim();
  const client = new Client(options, secretStrings(secret));
  try {
    return await checkToken(client, token);
  } catch (error) {
    if (error instanceof Stop) return error.result;
    return { ok: false, message: 'The token could not be checked. Try again.' };
  }
}

async function checkToken(client: Client, token: string): Promise<VerifyResult> {
  const reply = await client.send('GET', '/user', token);
  if (reply.status === 401) {
    throw new Stop(
      'GitHub rejected the token. It may be mistyped, expired or revoked. Create a new one under Settings, Developer settings, Personal access tokens.',
    );
  }
  if (reply.status >= 400) throw new Stop(client.describe(reply, 'the token'));
  const login = text(reply.json.login) ?? 'an unknown user';
  const details = [`Signed in as: ${login}`];
  const warnings: string[] = [];
  const scopes = reply.headers.get('x-oauth-scopes');
  let caveat = '';
  if (scopes === null) {
    caveat =
      ' GitHub does not show what a fine-grained token may do, so its permissions could not be checked.';
    details.push(
      'This token does not report its permissions, as with fine-grained tokens. Give it Read and write access to Contents, Pull requests and Actions on the repositories you need.',
    );
  } else {
    const list = scopes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    details.push(`Scopes: ${list.length ? list.join(', ') : 'none'}`);
    if (!list.includes('repo') && !list.includes('public_repo')) {
      warnings.push('The token has no repo scope, so it cannot read or change repositories.');
    }
  }
  const expires = reply.headers.get('github-authentication-token-expiration');
  if (expires) details.push(`Expires: ${expires}`);
  details.push(...warnings.map((w) => `Warning: ${w}`));
  return {
    ok: true,
    message: `Connected as ${login}.${caveat}${warnings.length ? ' Some scopes are missing.' : ''}`,
    details,
  };
}
