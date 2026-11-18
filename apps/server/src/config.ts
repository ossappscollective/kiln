import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { parseMasterKey } from '@mrm/vault';
import { z } from 'zod';
import type { GitSigning } from './services/local-git.ts';
import { parseExtraHosts } from './single-user.ts';

/** `KEY=` in an .env file is an empty string, which should read as "not set". */
const blankIsUnset = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** A size in bytes: digits, optionally followed by k, m, g or t (binary multiples; `2g` is 2 GiB, `kb` and `gib` also read). */
export function parseByteSize(value: string): number | undefined {
  const match = /^(\d{1,15})\s*([kmgt]?)(?:i?b)?$/i.exec(value.trim());
  if (!match) return undefined;
  const bytes = Number(match[1]) * (UNITS[(match[2] as string).toLowerCase()] as number);
  return Number.isSafeInteger(bytes) && bytes <= 1024 ** 5 ? bytes : undefined;
}

const byteSize = (name: string) =>
  z.string().transform((value, ctx): number => {
    const bytes = parseByteSize(value);
    if (bytes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be a size in bytes, or with a unit (500m, 2g), and at most 1 PiB; 0 is no limit`,
      });
      return z.NEVER;
    }
    return bytes;
  });

const schema = z.object({
  // SQLite by default so a bare `pnpm dev` works. Compose sets Postgres.
  DATABASE_URL: z.string().min(1).default('file:./.mrm-data/mrm.db'),
  MRM_MASTER_KEY: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  MRM_DATA_DIR: z.string().min(1).default('./.mrm-data'),
  MRM_WEB_DIST: z.string().min(1).default('apps/web/dist'),
  // 'inline' runs the job worker inside the server. 'off' leaves it to a separate process.
  MRM_WORKER: z.enum(['inline', 'off']).default('inline'),
  // Comma-separated origins allowed to send state-changing requests besides the server itself.
  MRM_TRUSTED_ORIGINS: z.string().default(''),
  // 'multi' is the hosted server with accounts. 'single_user' is the desktop app: no login,
  // loopback only, sessions start from MRM_LAUNCH_SECRET. See docs/adr/0003-single-user-mode.md.
  MRM_MODE: z.enum(['multi', 'single_user']).default('multi'),
  MRM_LAUNCH_SECRET: z.string().optional(),
  // Single-user only. Extra Host values to accept, comma separated, each a loopback name with a
  // port (for example localhost:5173 for the Vite dev server). Default: none.
  MRM_ALLOWED_HOSTS: z.string().default(''),
  // '1' when exactly one reverse proxy you control sits in front and sets X-Forwarded-For. The
  // client address (for the login rate limit) is then the last X-Forwarded-For entry. Leave it at
  // '0' otherwise: the header is client-controlled and would let anyone dodge the limit.
  MRM_TRUST_PROXY: z.enum(['0', '1']).default('0'),
  // '1' lets outbound webhooks go to loopback and private-network addresses, and to http://localhost
  // (for development and for receivers on your own network). Off by default: webhooks are https
  // to public addresses only, so a webhook cannot be aimed at the server's own network. Link-local
  // addresses, which hold the cloud metadata service, are refused either way.
  MRM_WEBHOOKS_ALLOW_PRIVATE: z.enum(['0', '1']).default('0'),
  // 'true' lets the LibreTranslate address of a workspace (a workspace setting an admin can change)
  // point at loopback and private-network addresses, and at http://localhost: self-hosted instances
  // are often on a LAN. Off by default: the address must then be https to a public host, so an admin
  // cannot aim review translation at this server's own network. Link-local addresses (cloud
  // metadata, 169.254.169.254, fd00:ec2::254) are refused either way. Turn it on only when every
  // person who can change workspace settings is trusted with your network. See docs/deployment.md.
  MRM_TRANSLATE_ALLOW_PRIVATE_URLS: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Where scans and listings read the repository. 'auto' (default) uses a local git clone and
  // falls back to the GitHub API for a request when the clone cannot be used. 'clone' never falls
  // back. 'api' is the GitHub REST API only. See docs/adr/0005-local-clone-reads.md.
  MRM_READS: blankIsUnset(z.enum(['api', 'clone', 'auto']).default('auto')),
  // An empty value (a bare `MRM_CLONE_DIR=` line in .env) means the default.
  MRM_CLONE_DIR: blankIsUnset(z.string().min(1).optional()),
  // How long a fetched branch tip is reused before the next read fetches again.
  MRM_CLONE_TTL_SECONDS: blankIsUnset(z.coerce.number().int().min(0).max(86_400).default(60)),
  // Upkeep of the clone folder (docs/adr/0005-local-clone-reads.md, "Clone upkeep"). The clones are
  // a cache, so pruning one only costs a fetch on its next read. MAX_BYTES is a size in bytes (or
  // with a unit: 500m, 2g); 0 is no limit. IDLE_DAYS: a clone unused for longer is removed; 0 never.
  // SWEEP_INTERVAL_MINUTES: how often the sweep runs; 0 turns it off, otherwise 5 to 10080.
  MRM_CLONE_MAX_BYTES: blankIsUnset(byteSize('MRM_CLONE_MAX_BYTES').default('2g')),
  MRM_CLONE_IDLE_DAYS: blankIsUnset(z.coerce.number().int().min(0).max(3650).default(30)),
  MRM_CLONE_SWEEP_INTERVAL_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 5 && v <= 10_080), 'must be 0 (off) or from 5 to 10080')
      .default(360),
  ),
  // The git program: `git` from PATH, or an absolute path.
  MRM_GIT_PATH: blankIsUnset(z.string().min(1).default('git')),
  // Folders that may hold local git clones to read (docs/adr/0005-local-clone-reads.md). Empty
  // (the default) turns local clones off. A list separated by `:` (`;` on Windows), absolute paths
  // only. See parseLocalRepoRoots.
  MRM_LOCAL_REPO_ROOTS: z.string().default(''),
  // 'true' lets the server write to a local clone: a commit on a NEW branch (never the checked out
  // one, never the working tree), and with the right options its push and a pull request. Off by
  // default; reading local clones does not need it. See docs/adr/0005-local-clone-reads.md.
  MRM_LOCAL_REPO_WRITE: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Author and committer of those commits. Optional: the person who applied the change set (their
  // display name and email) is used for what is not set. One line, no angle brackets.
  MRM_GIT_AUTHOR_NAME: blankIsUnset(
    z
      .string()
      .trim()
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f<>]+$/, 'must be one line without < or >')
      .optional(),
  ),
  MRM_GIT_AUTHOR_EMAIL: blankIsUnset(
    z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\s<>@\u0000-\u001f\u007f]+@[^\s<>@\u0000-\u001f\u007f]+$/, 'must look like name@example.com')
      .optional(),
  ),
  // Signing of the commits made in a local clone (docs/adr/0005-local-clone-reads.md, "Signing").
  // 'off' (the default) is the behaviour before signing existed. The key, the program and the
  // keyring are the server's own: the repository's and the user's git config are never consulted.
  // The rest of the checks (files, programs) are in parseGitSigning.
  MRM_GIT_SIGN: blankIsUnset(z.enum(['off', 'ssh', 'gpg']).default('off')),
  MRM_GIT_SIGNING_KEY: blankIsUnset(z.string().trim().optional()),
  MRM_GIT_SIGNING_PROGRAM: blankIsUnset(z.string().trim().optional()),
  MRM_GIT_GNUPGHOME: blankIsUnset(z.string().trim().optional()),
  // Minutes between scheduled store syncs of every app. 0 (the default) turns scheduled syncs off;
  // otherwise 5 to 10080 (a week). Scheduled syncs read the stores with the stored credentials,
  // so they are opt-in. See docs/api/ci.md.
  MRM_SYNC_INTERVAL_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 5 && v <= 10_080), 'must be 0 (off) or from 5 to 10080')
      .default(0),
  ),
  // Minutes between scheduled reads of the customer reviews of every app. 0 (the default) turns them
  // off; otherwise 15 to 10080. Google Play serves only about the last 7 days of reviews, so for
  // Play apps 360 (6 hours) or less is recommended: a longer gap can miss reviews for good.
  // See docs/api/reviews.md.
  MRM_REVIEW_SYNC_INTERVAL_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 15 && v <= 10_080), 'must be 0 (off) or from 15 to 10080')
      .default(0),
  ),
  // Days a stored customer review is kept (by the store's date of the review); older rows are
  // pruned by the scheduler. 0 keeps them for ever. Reviews are personal data of third parties.
  MRM_REVIEW_RETENTION_DAYS: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v >= 0 && v <= 3650, 'must be 0 (keep) or from 1 to 3650')
      .default(365),
  ),
  // Kill switch for replying to customer reviews (docs/adr/0007-review-replies.md). A reply is
  // published publicly in the App Store or Google Play in the organisation's name, so it is off by
  // default: every reply route answers 409 reply_disabled until this is 'true'. Reading and
  // triaging reviews do not depend on it.
  MRM_REVIEW_REPLY_ENABLED: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Kill switch for changing a LIVE rollout in a store (docs/adr/0008-store-rollout-writes.md): the
  // Google Play staged rollout share, halt, resume and complete, and the App Store phased release
  // pause, resume and release to all. It changes what users receive, so it is off by default: every
  // rollout route answers 409 rollout_disabled until this is 'true'. Planning data (rollout steps)
  // does not depend on it.
  MRM_STORE_ROLLOUT_ENABLED: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Kill switch for writing staged listing text and graphics into a store as a DRAFT (docs/adr/0009-staged-store-drafts.md):
  // the App Store version localizations and screenshots of the editable version, and a Google Play edit
  // committed with changesNotSentForReview. It never submits, sends for review or publishes. Off by
  // default: staging and previewing work, but the push route answers 409 store_draft_disabled until
  // this is 'true'.
  MRM_STORE_DRAFT_WRITE_ENABLED: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Kill switch for SUBMITTING the store's draft for review (docs/adr/0010-store-submit.md): an App Store
  // review submission of the editable version, or a Google Play commit that sends the held back changes to
  // review. It cannot be recalled from here, so it is off by default and separate from the draft switch:
  // the submit routes answer 409 store_submit_disabled until this is 'true'. It never releases a version
  // and never changes a rollout.
  MRM_STORE_SUBMIT_ENABLED: blankIsUnset(z.enum(['true', 'false']).default('false')),
  // Minutes between scheduled reads of the store listing of every app (texts, categories, age
  // rating, screenshot counts). 0 (the default) turns them off; otherwise 30 to 10080 (a week). A
  // listing read is many requests, so the floor is higher than the sync's. They use the stored
  // credentials, so they are opt-in. See docs/api/listing.md.
  MRM_LISTING_INTERVAL_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 30 && v <= 10_080), 'must be 0 (off) or from 30 to 10080')
      .default(0),
  ),
  // Minutes between runs of the plan reminders (deadlines close or passed, rollout steps whose time
  // has passed; sent as events, never as email). 0 turns them off; otherwise 5 to 10080. They only
  // run in the process that runs the worker. See docs/api/events.md.
  MRM_REMINDER_INTERVAL_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 5 && v <= 10_080), 'must be 0 (off) or from 5 to 10080')
      .default(15),
  ),
});

/** Most allowed roots, and the longest path, accepted for MRM_LOCAL_REPO_ROOTS. */
export const MAX_LOCAL_REPO_ROOTS = 20;
export const MAX_LOCAL_PATH_LENGTH = 4096;

/**
 * Parses MRM_LOCAL_REPO_ROOTS: the folders local git clones may live in. Blank is an empty list
 * (the feature is off). Throws a message that names the variable, never anything else, when an
 * entry is not an absolute path, has a `..` segment, a NUL byte or a line break, is the file
 * system root (which would allow every folder), or when there are too many. Paths are normalised
 * (`/Volumes/dev/` is `/Volumes/dev`) and listed once. Whether a folder exists is checked when
 * it is used, not here: a drive that is not mounted yet must not stop the server from starting.
 */
export function parseLocalRepoRoots(value: string | undefined, separator: string = delimiter): string[] {
  const roots: string[] = [];
  for (const raw of (value ?? '').split(separator)) {
    const entry = raw.trim();
    if (entry === '') continue;
    const problem = (why: string) =>
      new Error(`Invalid configuration:\n  MRM_LOCAL_REPO_ROOTS ${why} (entries are separated by "${separator}").`);
    if (entry.length > MAX_LOCAL_PATH_LENGTH) throw problem('has an entry that is too long');
    if (/[\u0000-\u001f\u007f]/.test(entry)) throw problem('has an entry with a control character');
    if (!isAbsolute(entry)) throw problem(`entry "${entry}" is not an absolute path`);
    if (entry.split(/[\\/]+/).includes('..')) throw problem(`entry "${entry}" must not contain ".."`);
    const normal = resolve(entry);
    if (parsePath(normal).root === normal) {
      throw problem(`entry "${entry}" is the root of the file system; name the folder that holds your projects`);
    }
    if (!roots.includes(normal)) roots.push(normal);
  }
  if (roots.length > MAX_LOCAL_REPO_ROOTS) throw new Error(`Invalid configuration:\n  MRM_LOCAL_REPO_ROOTS has more than ${MAX_LOCAL_REPO_ROOTS} entries.`);
  return roots;
}

/** A gpg key id or fingerprint: hex, optionally `0x` first and `!` last (that exact subkey). Nothing else is passed to gpg. */
export const GPG_KEY_PATTERN = /^(?:0x)?[0-9A-Fa-f]{8,64}!?$/;

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const canAccess = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};
const isExecutable = (path: string): boolean => isFile(path) && canAccess(path, constants.X_OK);

/** The first `count` bytes of a file as text, or undefined. Never logged. */
function head(path: string, count: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(count);
    return buffer.subarray(0, readSync(fd, buffer, 0, count, 0)).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The first of `names` that is an executable file in a folder of `pathEnv`: an absolute path, found once. */
function findOnPath(names: readonly string[], pathEnv: string | undefined): string | undefined {
  for (const name of names) {
    for (const dir of (pathEnv ?? '').split(delimiter)) {
      if (dir === '' || !isAbsolute(dir)) continue;
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Parses MRM_GIT_SIGN and its companions into the signing setup of local commits, or undefined
 * when signing is off (unset, blank or `off`: then nothing else is read, so today's behaviour is
 * unchanged). Fails fast, at start, with a message that names the variable and says what to fix.
 * The messages never contain the key's path or any part of the key.
 *
 * - ssh: MRM_GIT_SIGNING_KEY is an absolute path: a private key file (not readable by group or
 *   others), or the `.pub` of a key an ssh-agent holds (then the agent socket of the server's own
 *   environment, SSH_AUTH_SOCK, is passed on, if there is one). The program is ssh-keygen.
 * - gpg: MRM_GIT_SIGNING_KEY is a key id or fingerprint, MRM_GIT_GNUPGHOME is the keyring folder
 *   (required: the server does not use the home folder of its user). The program is gpg.
 * - MRM_GIT_SIGNING_PROGRAM: the absolute path of the program. Otherwise it is looked up in PATH
 *   once, here, and pinned: it is never looked up again and never taken from a repository.
 * Whether a passphrase-protected key is unlocked cannot be known here; signing says so when used.
 */
export function parseGitSigning(env: Record<string, string | undefined>, platform: string = process.platform): GitSigning | undefined {
  const get = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const format = get('MRM_GIT_SIGN') ?? 'off';
  if (format === 'off') return undefined;
  const problem = (why: string) => new Error(`Invalid configuration:\n  ${why}`);
  if (format !== 'ssh' && format !== 'gpg') {
    throw problem(`MRM_GIT_SIGN must be off, ssh or gpg (it is "${format.slice(0, 20)}").`);
  }
  if (platform === 'win32' && format === 'gpg') {
    throw problem('MRM_GIT_SIGN=gpg is not supported on Windows. Use ssh.');
  }
  const absolute = (name: string, value: string): void => {
    if (value.length > MAX_LOCAL_PATH_LENGTH) throw problem(`${name} is too long.`);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw problem(`${name} must not contain control characters.`);
    if (!isAbsolute(value)) throw problem(`${name} must be an absolute path (starting with /). "~" and relative paths are not expanded.`);
    if (value.split(/[\\/]+/).includes('..')) throw problem(`${name} must not contain "..".`);
  };

  const key = get('MRM_GIT_SIGNING_KEY');
  if (key === undefined) {
    throw problem(
      format === 'ssh'
        ? 'MRM_GIT_SIGNING_KEY is required when MRM_GIT_SIGN=ssh: the absolute path of an ssh private key file, or of the .pub of a key held by ssh-agent.'
        : 'MRM_GIT_SIGNING_KEY is required when MRM_GIT_SIGN=gpg: the id or fingerprint of the gpg key.',
    );
  }

  // The program, pinned.
  const configured = get('MRM_GIT_SIGNING_PROGRAM');
  let program: string;
  if (configured !== undefined) {
    absolute('MRM_GIT_SIGNING_PROGRAM', configured);
    // The gpg wrapper script quotes the path: a quote would end the quoting.
    if (/['"]/.test(configured)) throw problem('MRM_GIT_SIGNING_PROGRAM must not contain quotes.');
    if (!isExecutable(configured)) {
      throw problem('MRM_GIT_SIGNING_PROGRAM is not an executable file (check the path and its permissions).');
    }
    program = configured;
  } else {
    const found = findOnPath(format === 'ssh' ? ['ssh-keygen'] : ['gpg', 'gpg2'], env.PATH);
    if (!found) {
      throw problem(
        format === 'ssh'
          ? 'MRM_GIT_SIGN=ssh needs ssh-keygen, which was not found in PATH. Install OpenSSH, or set MRM_GIT_SIGNING_PROGRAM to the absolute path of ssh-keygen.'
          : 'MRM_GIT_SIGN=gpg needs gpg, which was not found in PATH. Install GnuPG 2.1 or later, or set MRM_GIT_SIGNING_PROGRAM to the absolute path of gpg.',
      );
    }
    if (/['"\u0000-\u001f]/.test(found)) throw problem('The signing program found in PATH has a quote in its path. Set MRM_GIT_SIGNING_PROGRAM to another one.');
    program = found;
  }

  if (format === 'gpg') {
    if (!GPG_KEY_PATTERN.test(key)) {
      throw problem('MRM_GIT_SIGNING_KEY must be a gpg key id or fingerprint: hexadecimal, 8 to 64 characters (a user name or e-mail address is not accepted).');
    }
    const home = get('MRM_GIT_GNUPGHOME');
    if (home === undefined) {
      throw problem('MRM_GIT_GNUPGHOME is required when MRM_GIT_SIGN=gpg: the absolute path of the folder with the keyring (usually ~/.gnupg of the user that owns the key). The server does not use its own user\'s home folder.');
    }
    absolute('MRM_GIT_GNUPGHOME', home);
    let directory = false;
    try {
      directory = statSync(home).isDirectory();
    } catch {
      // Reported below.
    }
    if (!directory) throw problem('MRM_GIT_GNUPGHOME is not a folder that exists.');
    if (!canAccess(home, constants.R_OK | constants.X_OK)) throw problem('MRM_GIT_GNUPGHOME is not readable by the user the server runs as.');
    return { format, key: key.replace(/^0x/i, ''), program, gnupgHome: home };
  }

  if (get('MRM_GIT_GNUPGHOME') !== undefined) {
    throw problem('MRM_GIT_GNUPGHOME only applies with MRM_GIT_SIGN=gpg. Remove it, or change MRM_GIT_SIGN.');
  }
  absolute('MRM_GIT_SIGNING_KEY', key);
  if (!isFile(key)) throw problem('MRM_GIT_SIGNING_KEY is not a file that exists (it must be a key file, not a folder).');
  if (!canAccess(key, constants.R_OK)) throw problem('MRM_GIT_SIGNING_KEY is not readable by the user the server runs as.');
  const start = head(key, 64);
  if (start === undefined) throw problem('MRM_GIT_SIGNING_KEY could not be read.');
  if (key.endsWith('.pub')) {
    if (!/^(?:ssh-|ecdsa-|sk-)/.test(start)) throw problem('MRM_GIT_SIGNING_KEY ends in .pub but is not an ssh public key.');
    const sock = get('SSH_AUTH_SOCK');
    if (sock !== undefined) absolute('SSH_AUTH_SOCK', sock);
    return { format, key, program, ...(sock !== undefined ? { sshAuthSock: sock } : {}) };
  }
  if (/^(?:ssh-|ecdsa-|sk-)/.test(start)) {
    throw problem('MRM_GIT_SIGNING_KEY is an ssh public key but its name does not end in .pub. Rename it, or point to the private key.');
  }
  if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(start)) throw problem('MRM_GIT_SIGNING_KEY is not an ssh private key file.');
  if (platform !== 'win32' && (statSync(key).mode & 0o077) !== 0) {
    throw problem('MRM_GIT_SIGNING_KEY is readable by other users (ssh refuses such a key). Run: chmod 600 on the key file.');
  }
  return { format, key, program };
}

/** At least 43 URL-safe characters (32 bytes as base64url) or 64 hex characters. */
const LAUNCH_SECRET_SHAPE = /^[A-Za-z0-9_-]{43,512}$/;
const MIN_DISTINCT_CHARS = 12;

/** Never includes the value in its message. */
function checkLaunchSecret(secret: string | undefined): string {
  const hint = 'MRM_LAUNCH_SECRET must be 32 random bytes as base64url (43 characters) or hex (64). Generate one with: openssl rand -hex 32';
  if (!secret?.trim()) {
    throw new Error(`Invalid configuration:\n  MRM_LAUNCH_SECRET is required when MRM_MODE=single_user. ${hint}`);
  }
  // A sanity check, not proof of entropy: it catches short, padded or repetitive values.
  if (!LAUNCH_SECRET_SHAPE.test(secret) || new Set(secret).size < MIN_DISTINCT_CHARS) {
    throw new Error(`Invalid configuration:\n  MRM_LAUNCH_SECRET is too short or not random enough. ${hint}`);
  }
  return secret;
}

export type Config = {
  databaseUrl: string;
  masterKey: Buffer;
  port: number;
  dataDir: string;
  webDist: string;
  worker: 'inline' | 'off';
  trustedOrigins: string[];
  mode: 'multi' | 'single_user';
  /** Single-user mode only. Treat as a password: never log it. */
  launchSecret?: string;
  /** Interface to listen on. Single-user mode is loopback only; undefined means the default. */
  host?: string;
  /** Single-user mode only: extra accepted Host values besides this server's own. */
  allowedHosts: string[];
  /** Believe X-Forwarded-For for the client address. See MRM_TRUST_PROXY. */
  trustProxy: boolean;
  /** Webhooks may reach private addresses and http://localhost. See MRM_WEBHOOKS_ALLOW_PRIVATE. */
  webhooksAllowPrivate: boolean;
  /** The LibreTranslate address may be private or loopback. See MRM_TRANSLATE_ALLOW_PRIVATE_URLS. */
  translateAllowPrivateUrls: boolean;
  /** How scans and listings read the repository. See MRM_READS. */
  reads: 'api' | 'clone' | 'auto';
  /** Where git clones live: MRM_CLONE_DIR, default `<dataDir>/clones`. */
  cloneDir: string;
  /** How long a fetched branch tip is reused, in milliseconds (MRM_CLONE_TTL_SECONDS). */
  cloneTtlMs: number;
  /** Most bytes the clone folder may hold; 0 is no limit (MRM_CLONE_MAX_BYTES). */
  cloneMaxBytes: number;
  /** A clone unused for this many days is removed; 0 never (MRM_CLONE_IDLE_DAYS). */
  cloneIdleDays: number;
  /** Minutes between sweeps of the clone folder; 0 is off (MRM_CLONE_SWEEP_INTERVAL_MINUTES). */
  cloneSweepIntervalMinutes: number;
  /** The git program (MRM_GIT_PATH). */
  gitPath: string;
  /** Minutes between scheduled syncs of every app; 0 is off (MRM_SYNC_INTERVAL_MINUTES). */
  syncIntervalMinutes: number;
  /** Minutes between scheduled review reads of every app; 0 is off (MRM_REVIEW_SYNC_INTERVAL_MINUTES). */
  reviewSyncIntervalMinutes: number;
  /** Days a stored review is kept; 0 keeps them (MRM_REVIEW_RETENTION_DAYS). */
  reviewRetentionDays: number;
  /** Replying to customer reviews in the stores is allowed (MRM_REVIEW_REPLY_ENABLED). Default false. */
  reviewReplyEnabled: boolean;
  /** Changing a live rollout in the stores is allowed (MRM_STORE_ROLLOUT_ENABLED). Default false. */
  storeRolloutEnabled: boolean;
  /** Writing staged listing text and graphics into a store as a draft is allowed (MRM_STORE_DRAFT_WRITE_ENABLED). Default false. */
  storeDraftWriteEnabled: boolean;
  /** Submitting the store's draft for review is allowed (MRM_STORE_SUBMIT_ENABLED). Default false. */
  storeSubmitEnabled: boolean;
  /** Minutes between scheduled reads of the store listing of every app; 0 is off (MRM_LISTING_INTERVAL_MINUTES). */
  listingIntervalMinutes: number;
  /** Minutes between runs of the plan reminders; 0 is off (MRM_REMINDER_INTERVAL_MINUTES). */
  reminderIntervalMinutes: number;
  /** Folders that may hold local clones (MRM_LOCAL_REPO_ROOTS). Empty: local clones are off. */
  localRepoRoots: string[];
  /** Commits on a new branch of a local clone, and their push, are allowed (MRM_LOCAL_REPO_WRITE). */
  localRepoWrite: boolean;
  /** MRM_GIT_AUTHOR_NAME and MRM_GIT_AUTHOR_EMAIL, when set. */
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /** Signing of local commits (MRM_GIT_SIGN). Absent: commits are not signed. Holds a key path: never log or return it. */
  gitSigning?: GitSigning;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (!env.MRM_MASTER_KEY?.trim()) {
    throw new Error(
      'Invalid configuration:\n  MRM_MASTER_KEY is required. Generate one with: openssl rand -base64 32',
    );
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const data = parsed.data;
  // Ignored in multi-user mode: nothing there consumes it.
  const launchSecret = data.MRM_MODE === 'single_user' ? checkLaunchSecret(data.MRM_LAUNCH_SECRET) : undefined;
  const localRepoRoots = parseLocalRepoRoots(data.MRM_LOCAL_REPO_ROOTS);
  const gitSigning = parseGitSigning(env);
  const allowedHosts = data.MRM_MODE === 'single_user' ? parseExtraHosts(data.MRM_ALLOWED_HOSTS) : [];
  return {
    databaseUrl: data.DATABASE_URL,
    masterKey: parseMasterKey(env.MRM_MASTER_KEY),
    port: data.PORT,
    dataDir: data.MRM_DATA_DIR,
    webDist: data.MRM_WEB_DIST,
    worker: data.MRM_WORKER,
    trustedOrigins: data.MRM_TRUSTED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    mode: data.MRM_MODE,
    launchSecret,
    host: data.MRM_MODE === 'single_user' ? '127.0.0.1' : undefined,
    allowedHosts,
    trustProxy: data.MRM_TRUST_PROXY === '1',
    webhooksAllowPrivate: data.MRM_WEBHOOKS_ALLOW_PRIVATE === '1',
    translateAllowPrivateUrls: data.MRM_TRANSLATE_ALLOW_PRIVATE_URLS === 'true',
    reads: data.MRM_READS,
    cloneDir: data.MRM_CLONE_DIR ?? join(data.MRM_DATA_DIR, 'clones'),
    cloneTtlMs: data.MRM_CLONE_TTL_SECONDS * 1000,
    cloneMaxBytes: data.MRM_CLONE_MAX_BYTES,
    cloneIdleDays: data.MRM_CLONE_IDLE_DAYS,
    cloneSweepIntervalMinutes: data.MRM_CLONE_SWEEP_INTERVAL_MINUTES,
    gitPath: data.MRM_GIT_PATH,
    syncIntervalMinutes: data.MRM_SYNC_INTERVAL_MINUTES,
    reviewSyncIntervalMinutes: data.MRM_REVIEW_SYNC_INTERVAL_MINUTES,
    reviewRetentionDays: data.MRM_REVIEW_RETENTION_DAYS,
    reviewReplyEnabled: data.MRM_REVIEW_REPLY_ENABLED === 'true',
    storeRolloutEnabled: data.MRM_STORE_ROLLOUT_ENABLED === 'true',
    storeDraftWriteEnabled: data.MRM_STORE_DRAFT_WRITE_ENABLED === 'true',
    storeSubmitEnabled: data.MRM_STORE_SUBMIT_ENABLED === 'true',
    listingIntervalMinutes: data.MRM_LISTING_INTERVAL_MINUTES,
    reminderIntervalMinutes: data.MRM_REMINDER_INTERVAL_MINUTES,
    localRepoRoots,
    localRepoWrite: data.MRM_LOCAL_REPO_WRITE === 'true',
    ...(data.MRM_GIT_AUTHOR_NAME ? { gitAuthorName: data.MRM_GIT_AUTHOR_NAME } : {}),
    ...(data.MRM_GIT_AUTHOR_EMAIL ? { gitAuthorEmail: data.MRM_GIT_AUTHOR_EMAIL } : {}),
    ...(gitSigning ? { gitSigning } : {}),
  };
}
