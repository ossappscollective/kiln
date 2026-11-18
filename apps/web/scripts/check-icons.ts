// Validates every icon in src/lib/icons.ts: path grammar, element whitelist and bounds inside the
// 24 x 24 viewBox. Prints one line per icon and exits 1 on any problem. Run: pnpm --filter @mrm/web icons:check
import { checkIcon } from '../src/lib/icon-geometry.ts';
import { icons } from '../src/lib/icons.ts';

let failed = 0;
for (const [name, def] of Object.entries(icons)) {
  const { box, problems } = checkIcon(def.style, def.body);
  const size = `${box.minX.toFixed(1)},${box.minY.toFixed(1)} - ${box.maxX.toFixed(1)},${box.maxY.toFixed(1)}`;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(18)} ${def.style.padEnd(6)} ${size}${problems.length ? `  ${problems.join('; ')}` : ''}`);
  if (problems.length) failed++;
}
console.log(`${Object.keys(icons).length} icons, ${failed} failed`);
process.exit(failed ? 1 : 0);
