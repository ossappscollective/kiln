import { join } from 'node:path';
import { parseMasterKey } from '@mrm/vault';
import { z } from 'zod';
import { parseExtraHosts } from './single-user.ts';

/** `KEY=` in an .env file is an empty string, which should read as "not set". */
const blankIsUnset = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

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
  // Where scans and listings read the repository. 'auto' (default) uses a local git clone and
  // falls back to the GitHub API for a request when the clone cannot be used. 'clone' never falls
  // back. 'api' is the GitHub REST API only. See docs/adr/0005-local-clone-reads.md.
  MRM_READS: blankIsUnset(z.enum(['api', 'clone', 'auto']).default('auto')),
  // An empty value (a bare `MRM_CLONE_DIR=` line in .env) means the default.
  MRM_CLONE_DIR: blankIsUnset(z.string().min(1).optional()),
  // How long a fetched branch tip is reused before the next read fetches again.
  MRM_CLONE_TTL_SECONDS: blankIsUnset(z.coerce.number().int().min(0).max(86_400).default(60)),
  // The git program: `git` from PATH, or an absolute path.
  MRM_GIT_PATH: blankIsUnset(z.string().min(1).default('git')),
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
});

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
  /** How scans and listings read the repository. See MRM_READS. */
  reads: 'api' | 'clone' | 'auto';
  /** Where git clones live: MRM_CLONE_DIR, default `<dataDir>/clones`. */
  cloneDir: string;
  /** How long a fetched branch tip is reused, in milliseconds (MRM_CLONE_TTL_SECONDS). */
  cloneTtlMs: number;
  /** The git program (MRM_GIT_PATH). */
  gitPath: string;
  /** Minutes between scheduled syncs of every app; 0 is off (MRM_SYNC_INTERVAL_MINUTES). */
  syncIntervalMinutes: number;
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
    reads: data.MRM_READS,
    cloneDir: data.MRM_CLONE_DIR ?? join(data.MRM_DATA_DIR, 'clones'),
    cloneTtlMs: data.MRM_CLONE_TTL_SECONDS * 1000,
    gitPath: data.MRM_GIT_PATH,
    syncIntervalMinutes: data.MRM_SYNC_INTERVAL_MINUTES,
  };
}
