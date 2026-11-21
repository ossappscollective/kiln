// Entry point of the packaged server. See docs/adr/0004-desktop-sidecar.md.
//
// The desktop shell runs: kiln-node --disable-warning=ExperimentalWarning launcher.mjs
//
// Node strips the TypeScript types of the server and workspace packages at load time. The
// workspace packages are normally found through pnpm's node_modules symlinks, which a bundled
// copy does not have, so a small resolve hook maps `@kiln/<name>` to the copied package folder.
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

register('./workspace-resolve.mjs', import.meta.url, { data: { root } });

await import(pathToFileURL(join(root, 'apps/server/src/index.ts')).href);
