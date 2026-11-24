// Recognise desktop release files by name: kiln_<version>_<os>_<arch>.<ext>. Pure functions, tested with node --test.
export const TARGETS = [
  { id: 'macos-arm64', os: 'macos', arch: 'arm64', exts: ['dmg'] },
  { id: 'macos-x64', os: 'macos', arch: 'x64', exts: ['dmg'] },
  { id: 'windows-x64', os: 'windows', arch: 'x64', exts: ['msi', 'exe'] },
  { id: 'linux-x64', os: 'linux', arch: 'x64', exts: ['appimage', 'deb', 'rpm'] },
];

const OS = { macos: 'macos', mac: 'macos', darwin: 'macos', windows: 'windows', win: 'windows', linux: 'linux' };
const ARCH = {
  arm64: 'arm64',
  aarch64: 'arm64',
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  intel: 'x64',
  universal: 'universal',
};

/** @returns {{ version: string, os: string, arch: string, ext: string } | null} */
export function parseAssetName(name) {
  const m = /^kiln_(.+?)_(macos|mac|darwin|windows|win|linux)_([a-z0-9_]+)\.([a-z0-9]+(?:\.[a-z0-9]+){0,2})$/i.exec(
    String(name),
  );
  if (!m) return null;
  const os = OS[m[2].toLowerCase()];
  const arch = ARCH[m[3].toLowerCase()];
  if (!os || !arch) return null;
  return { version: m[1], os, arch, ext: m[4].toLowerCase() };
}

/**
 * Pick the file to offer for each target. The first matching extension in the target's order wins.
 * @param {{ name: string, browser_download_url: string, size?: number }[]} assets
 * @returns {Record<string, { name: string, url: string, size: number, ext: string }>}
 */
export function pickAssets(assets) {
  const out = {};
  for (const target of TARGETS) {
    let best = null;
    for (const asset of assets ?? []) {
      const parsed = parseAssetName(asset.name);
      if (!parsed || parsed.os !== target.os) continue;
      if (parsed.arch !== target.arch && parsed.arch !== 'universal') continue;
      const rank = target.exts.indexOf(parsed.ext);
      if (rank === -1) continue;
      const score = rank * 2 + (parsed.arch === 'universal' ? 1 : 0);
      if (!best || score < best.score) {
        best = { score, name: asset.name, url: asset.browser_download_url, size: asset.size ?? 0, ext: parsed.ext };
      }
    }
    if (best) out[target.id] = { name: best.name, url: best.url, size: best.size, ext: best.ext };
  }
  return out;
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Only links on github.com are ever put into the page. */
export function isGithubUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
  } catch {
    return false;
  }
}
