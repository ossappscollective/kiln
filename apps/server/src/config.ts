import { parseMasterKey } from '@mrm/vault';
import { z } from 'zod';
import { parseExtraHosts } from './single-user.ts';

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
  };
}
