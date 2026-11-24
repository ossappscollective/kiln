// Link rewriting for rendered Markdown: a relative link to another .md file of the curated set becomes the route of
// its page on the site; any other relative link points at the file on GitHub.
import path from 'node:path';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {object} options
 * @param {string} options.sourcePath  repo-relative path of the Markdown file being rendered (posix)
 * @param {Map<string,string>} options.routes  repo-relative .md path -> route under the site root, e.g. 'docs/security/'
 * @param {string} options.root  prefix from the page being built back to the site root: './', '../', '../../'
 * @param {string} options.repoUrl  e.g. https://github.com/ossappscollective/kiln
 * @param {string} [options.branch]
 * @returns {(url: string) => string}
 */
export function createLinkResolver({ sourcePath, routes, root, repoUrl, branch = 'main' }) {
  const dir = path.posix.dirname(sourcePath);
  return (url) => {
    const raw = String(url).trim();
    if (raw === '' || raw.startsWith('#') || raw.startsWith('//') || SCHEME.test(raw)) return raw;
    const cut = raw.search(/[?#]/);
    const pathPart = cut === -1 ? raw : raw.slice(0, cut);
    const rest = cut === -1 ? '' : raw.slice(cut);
    const hash = rest.includes('#') ? rest.slice(rest.indexOf('#')) : '';
    const target = pathPart.startsWith('/')
      ? path.posix.normalize(pathPart.slice(1))
      : path.posix.normalize(path.posix.join(dir, pathPart));
    if (target.startsWith('..')) return repoUrl;
    const clean = target.replace(/\/$/, '');
    const route = routes.get(clean);
    if (route !== undefined) return `${root}${route}${hash}`;
    if (clean === '' || clean === '.') return repoUrl;
    const last = clean.split('/').pop();
    // a trailing slash, or a lowercase name without a dot (apps/server), is a folder; Dockerfile and LICENSE are files
    const kind = !pathPart.endsWith('/') && (last.includes('.') || /^[A-Z]/.test(last)) ? 'blob' : 'tree';
    return `${repoUrl}/${kind}/${branch}/${clean}${hash}`;
  };
}
