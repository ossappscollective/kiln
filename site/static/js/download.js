// Download section: optionally asks GitHub's public Releases API for the latest release and fills in the version and
// the file links. The page works without it: every card already links to the releases page. The request is made only
// when the section is about to be seen, at most once an hour per browser (sessionStorage), and sends no cookies.
import { formatSize, isGithubUrl, pickAssets } from './release-assets.js';

const KEY = 'kiln-site-release-v1';
const TTL = 60 * 60 * 1000;

function readCache() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (raw && Date.now() - raw.at < TTL) return raw.data;
  } catch {
    // ignore: no cache
  }
  return null;
}

function writeCache(data) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // ignore: storage blocked
  }
}

async function latest(api) {
  const cached = readCache();
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(api, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (res.status === 404) {
      const none = { none: true };
      writeCache(none);
      return none;
    }
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    const data = {
      tag: String(json.tag_name ?? ''),
      url: String(json.html_url ?? ''),
      date: String(json.published_at ?? ''),
      assets: (json.assets ?? []).map((a) => ({
        name: String(a.name),
        browser_download_url: String(a.browser_download_url),
        size: Number(a.size) || 0,
      })),
    };
    writeCache(data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function apply(root, data) {
  const status = root.querySelector('[data-release-status]');
  if (data.none) {
    if (status) status.textContent = 'No release has been published yet. Use Docker or run from source for now.';
    return;
  }
  const version = data.tag.replace(/^v/, '');
  for (const el of root.querySelectorAll('[data-release-version]')) el.textContent = version;
  const when = data.date ? new Date(data.date) : null;
  for (const el of root.querySelectorAll('[data-release-date]')) {
    if (when && !Number.isNaN(when.getTime())) el.textContent = when.toISOString().slice(0, 10);
  }
  for (const el of root.querySelectorAll('[data-release-notes]')) {
    if (isGithubUrl(data.url)) el.setAttribute('href', data.url);
  }
  const picked = pickAssets(data.assets);
  let found = 0;
  for (const card of root.querySelectorAll('[data-target]')) {
    const asset = picked[card.getAttribute('data-target')];
    const link = card.querySelector('a.btn');
    if (!asset || !link || !isGithubUrl(asset.url)) continue;
    found++;
    link.setAttribute('href', asset.url);
    const size = formatSize(asset.size);
    link.textContent = `Download .${asset.ext}${size ? ` (${size})` : ''}`;
  }
  if (status) {
    status.textContent = found
      ? `Latest release: ${version}. Links point at the files of that release.`
      : `Latest release: ${version}. No desktop file matched yet; open the release page for what it contains.`;
  }
}

export function initDownload() {
  const root = document.getElementById('download');
  if (!root) return;
  const api = root.getAttribute('data-api');
  if (!api) return;
  let started = false;
  const run = async () => {
    if (started) return;
    started = true;
    try {
      apply(root, await latest(api));
    } catch {
      // the static links stay: nothing else to do
    }
  };
  if (typeof IntersectionObserver !== 'function') {
    run();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        run();
      }
    },
    { rootMargin: '300px 0px' },
  );
  observer.observe(root);
}
