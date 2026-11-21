import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDemoRuntime, wipe } from './boot.ts';
import { demoRequested, loadDemoConfig } from './config.ts';

/**
 * Entry point of demo mode (`pnpm demo`, or `KILN_DEMO=true` with the normal start script): see docs/demo.md.
 * Reads only KILN_DEMO, KILN_DEMO_DIR, KILN_DEMO_PORT, KILN_DEMO_FORCE and the safety checks of config.ts. Never reads `.env`.
 */
export async function runDemo(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!demoRequested(env) && env.KILN_DEMO_ENTRY !== '1')
    throw new Error('Demo mode is off. Set KILN_DEMO=true.');
  const webDist = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  let config: ReturnType<typeof loadDemoConfig>;
  try {
    config = loadDemoConfig(env, webDist);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  console.log(
    `Demo mode: data in ${config.dataDir} (its own SQLite file; the real database and master key are never read).`,
  );
  if (process.argv.includes('--reset') || env.KILN_DEMO_RESET === '1') {
    if (existsSync(config.dataDir)) await wipe(config);
    console.log('Demo data reset: starting from a freshly seeded workspace.');
  }
  const runtime = await createDemoRuntime(config);
  for (const w of runtime.warnings) console.warn(`Demo: ${w}`);
  if (!existsSync(webDist))
    console.warn(`No web UI at ${webDist}. Serving the API only. Run: pnpm build`);
  const server = serve(
    { fetch: runtime.app.fetch, port: config.port, hostname: config.host },
    (info) => {
      console.log(
        `\nDemo workspace ready: http://localhost:${info.port}/demo/login   (signs you in as the demo owner)`,
      );
      console.log(
        `  other users: /demo/login?as=admin | member | viewer      status: /demo/status`,
      );
      console.log(
        '  stores, GitHub, translation, AI and analytics are simulated. Nothing leaves this machine.',
      );
    },
  );
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    server.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Started directly: `node src/demo/main.ts`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runDemo({ ...process.env, KILN_DEMO: 'true' });
}
