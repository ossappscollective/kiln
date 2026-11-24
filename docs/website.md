# The project website

The site at <https://ossappscollective.github.io/kiln/> is built from the `site/` folder and the Markdown in this repository. It has no dependencies: hand-written HTML and CSS, a few small JavaScript modules and one Node build script. Nothing is installed to build it, and the page makes no third-party requests. The single optional exception is a request to GitHub's public releases API when a visitor scrolls to the download section.

## Layout

| Path | What it is |
| --- | --- |
| `site/build.mjs` | The generator: `node site/build.mjs` writes `site/dist` (git-ignored). |
| `site/lib/` | The Markdown renderer, link rewriting, search index, page templates and `config.mjs` (site settings and the list of docs pages). |
| `site/pages/home.html` | The body of the home page. `{{name}}` placeholders are filled by the build, and an unknown name fails the build. |
| `site/content/` | Docs pages written for the site (getting started, self-hosting, configuration, FAQ, API overview). |
| `site/static/` | Copied to `dist` as is: `css/`, `js/` and `assets/` (logo, favicon, social image). |
| `site/test/` | Tests, run with `node --test`. |
| `site/tools/render-og.py` | Renders `assets/og.png` (needs Python with Pillow and numpy). |

## Build and test

```sh
pnpm site:build     # node site/build.mjs, output in site/dist
pnpm site:test      # node --test "site/test/*.test.mjs"
```

To look at the result, serve `site/dist` with any static server, for example `python3 -m http.server -d site/dist 8000`, and open `http://localhost:8000/`. Pages use relative URLs, so they also work under a sub-path such as `/kiln/`.

The build reads `SITE_URL` (default `https://ossappscollective.github.io/kiln/`). It is used for the canonical links, the Open Graph tags, `sitemap.xml` and `robots.txt`, and for the absolute asset paths of `404.html` (a 404 page is served at any depth, so it cannot use relative URLs).

## Add a docs page

1. Write the Markdown file, either under `docs/` or, for a page that only makes sense on the site, under `site/content/`.
2. Add an entry to `docsGroups` in `site/lib/config.mjs`: `{ slug: 'my-page', source: 'docs/my-page.md', nav: 'Sidebar title' }`. The first `# Heading` becomes the page title, and the first paragraph becomes the description (set `description` to override it).
3. Run `pnpm site:build` and `pnpm site:test`.

How links are handled: a relative link to another Markdown file that is in the list becomes a link to that page on the site. Any other relative link (an ADR, a source file, a folder) becomes a link to that file on GitHub. Images in Markdown are shown as links, not embedded. Raw HTML in Markdown is shown as text. Only `http`, `https` and `mailto` addresses survive in links.

A page can be marked `optional: true`: it is skipped when the file does not exist (this is how `docs/releasing.md` is linked only once it exists).

## Look and feel

`site/static/css/tokens.css` is a copy of the colour, type and spacing tokens of the app (`apps/web/src/styles/theme.css`), light and dark. A test fails when a solid colour differs from the app's, and another checks WCAG contrast (4.5:1 for text, 3:1 for interface parts) for the pairs the site uses, in both themes. The theme toggle stores its choice in `localStorage` (and works when storage is blocked). Animation is switched off under `prefers-reduced-motion`.

## Publish with GitHub Pages

1. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow `.github/workflows/pages.yml` runs when `site/**` or `docs/**` change (or by hand with **Run workflow**), tests the site, builds it and deploys it.
3. The site appears at `https://<owner>.github.io/<repo>/`.

### A custom domain

1. Under **Settings > Pages > Custom domain**, enter the domain and follow GitHub's DNS instructions (an `A`/`AAAA` record set or a `CNAME` for a subdomain), then enable **Enforce HTTPS**.
2. Nothing else is needed: the workflow passes the address that `actions/configure-pages` reports (your custom domain when one is set) to the build as `SITE_URL`, so canonical links, the sitemap and `404.html` follow it. For a local build, set `SITE_URL` yourself.
3. Because every URL on the pages is relative, nothing else changes. With a custom domain the site is served from the root instead of `/kiln/`.

## What is not verified

The site was built and tested without network access and without a browser. Not checked: how it renders in real browsers, a Lighthouse run, the Pages deployment itself, and the live GitHub releases lookup (its fallback is static links to the releases page).
