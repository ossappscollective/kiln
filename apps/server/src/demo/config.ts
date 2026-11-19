import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Demo mode (docs/demo.md, docs/adr/0018-demo-mode.md). A separate entry point with its own data
 * folder, its own SQLite file and a built-in master key. It never reads the real master key, the real
 * database or any `.env` file, and it refuses to start in a setup that looks like a real one.
 */

export const DEMO_DEFAULT_DIR = './.mrm-demo';
export const DEMO_DEFAULT_PORT = 8788;
export const DEMO_MARKER = '.mrm-demo';
export const DEMO_DB_FILE = 'demo.db';
export const DEMO_WORLD_FILE = 'world.json';
export const DEMO_WORKSPACE_NAME = 'Demo Studio';

/** `MRM_DEMO=true` (or `1`). Anything else, or nothing, is off. */
export function demoRequested(env: Record<string, string | undefined>): boolean {
  const v = env.MRM_DEMO?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const forced = (env: Record<string, string | undefined>) => {
  const v = env.MRM_DEMO_FORCE?.trim().toLowerCase();
  return v === 'true' || v === '1';
};

/**
 * What stops a demo from starting. The first group can be overridden with MRM_DEMO_FORCE=true (a setup
 * that merely looks like a real one); the second never can (it would write demo data into a real folder).
 */
export function demoProblems(env: Record<string, string | undefined>, dataDir: string): { soft: string[]; hard: string[] } {
  const soft: string[] = [];
  const hard: string[] = [];
  const url = env.DATABASE_URL?.trim();
  if (url && /^postgres(ql)?:/i.test(url)) soft.push('DATABASE_URL points at Postgres. The demo only ever uses its own SQLite file.');
  if (env.NODE_ENV === 'production') soft.push('NODE_ENV is "production". The demo is for a developer machine.');
  if (env.MRM_MASTER_KEY?.trim()) soft.push('MRM_MASTER_KEY is set in this environment. The demo never reads it; unset it (or set MRM_DEMO_FORCE=true) to confirm this is not a real setup.');
  if (env.MRM_MODE === 'single_user') soft.push('MRM_MODE=single_user is set. That is the desktop setup, not a demo.');
  const dir = resolve(dataDir);
  if (basename(dir) === '.mrm-data') hard.push(`${dir} is the folder of the real server. The demo needs its own folder (default ${DEMO_DEFAULT_DIR}).`);
  if (existsSync(dir)) {
    const isDir = statSync(dir).isDirectory();
    if (!isDir) hard.push(`${dir} is not a folder.`);
    else if (!existsSync(join(dir, DEMO_MARKER)) && readdirSync(dir).length > 0) {
      hard.push(`${dir} already holds files that are not a demo (no ${DEMO_MARKER} marker). Choose an empty or new folder with MRM_DEMO_DIR.`);
    }
  }
  return { soft, hard };
}

export type DemoConfig = {
  dataDir: string;
  databaseUrl: string;
  worldFile: string;
  port: number;
  host: string;
  masterKey: Buffer;
  webDist: string;
};

/** The built-in key. It protects nothing real: the demo only holds made-up credentials. */
export const demoMasterKey = (): Buffer => createHash('sha256').update('mobile-release-manager demo master key v1').digest();

export function loadDemoConfig(env: Record<string, string | undefined> = process.env, webDist = ''): DemoConfig {
  const dataDir = resolve(env.MRM_DEMO_DIR?.trim() || DEMO_DEFAULT_DIR);
  const { soft, hard } = demoProblems(env, dataDir);
  const problems = [...hard, ...(forced(env) ? [] : soft)];
  if (problems.length > 0) {
    throw new Error(`Demo mode refuses to start:\n  - ${problems.join('\n  - ')}`);
  }
  const rawPort = env.MRM_DEMO_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEMO_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Demo mode refuses to start:\n  - MRM_DEMO_PORT must be a port number, got "${rawPort}".`);
  return {
    dataDir,
    databaseUrl: `file:${join(dataDir, DEMO_DB_FILE)}`,
    worldFile: join(dataDir, DEMO_WORLD_FILE),
    port,
    // Loopback only: the demo signs anyone in without a password.
    host: '127.0.0.1',
    masterKey: demoMasterKey(),
    webDist,
  };
}
