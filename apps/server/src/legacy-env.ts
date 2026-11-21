/**
 * Upgrade path from the working-title environment names (`MRM_*`) to `KILN_*`
 * (docs/adr/0040-rename-to-kiln.md, docs/deployment.md "Upgrading from the working-title names").
 *
 * `applyLegacyEnv` runs once where a process first reads its environment (server start, the MCP
 * bridge, the demo). For every `MRM_X` that is set while `KILN_X` is not, it copies the value to
 * `KILN_X`. It never overwrites a `KILN_` variable and never prints a value: the one warning lists
 * names only, because values can be secrets (`MRM_MASTER_KEY`).
 */

export type EnvLike = Record<string, string | undefined>;

export const LEGACY_ENV_PREFIX = 'MRM_';
export const ENV_PREFIX = 'KILN_';

const reported = new Set<string>();

/**
 * Copies `MRM_X` to `KILN_X` where only the old name is set, and returns the old names it used (sorted).
 * Logs one short warning with those names through `warn` (default: standard error), and no name
 * twice in one process.
 */
export function applyLegacyEnv(
  env: EnvLike = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string[] {
  const taken: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX) || name.length === LEGACY_ENV_PREFIX.length) continue;
    const value = env[name];
    if (value === undefined) continue;
    const next = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (env[next] !== undefined) continue;
    env[next] = value;
    taken.push(name);
  }
  taken.sort();
  const fresh = taken.filter((name) => !reported.has(name));
  for (const name of fresh) reported.add(name);
  if (fresh.length > 0) {
    warn(
      `Kiln: ${fresh.join(', ')} ${fresh.length === 1 ? 'is' : 'are'} set under the old ${LEGACY_ENV_PREFIX} prefix and ` +
        `${fresh.length === 1 ? 'was' : 'were'} read as ${ENV_PREFIX}. Rename ${fresh.length === 1 ? 'it' : 'them'} ` +
        '(docs/deployment.md, "Upgrading from the working-title names").',
    );
  }
  return taken;
}

/** Test hook: forget which names were already reported. */
export function resetLegacyEnvReport(): void {
  reported.clear();
}
