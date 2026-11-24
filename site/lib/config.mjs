// Site-wide settings and the curated list of documentation pages.
// To add a docs page: add an entry to `docsGroups` (see docs/website.md).

function withSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

export const site = {
  name: 'Kiln',
  repoUrl: 'https://github.com/ossappscollective/kiln',
  image: 'ghcr.io/ossappscollective/kiln',
  // Absolute address of the site root. GitHub Pages project sites live under /kiln/; for a custom domain set SITE_URL.
  siteUrl: withSlash(process.env.SITE_URL || 'https://ossappscollective.github.io/kiln/'),
  title: 'Kiln: ship iOS, macOS and Android releases from one open-source place',
  description:
    'Kiln is a free, self-hosted release manager for iOS, macOS and Android apps: releases, store listings, graphics, ASO, reviews and insights in one place, with your keys kept in an encrypted vault.',
};

/**
 * Each page: slug (the URL: docs/<slug>/), source (repo-relative Markdown file), optional nav (sidebar title),
 * description (otherwise the first paragraph), optional (skipped when the file does not exist).
 */
export const docsGroups = [
  {
    title: 'Start here',
    pages: [
      { slug: 'getting-started', source: 'site/content/getting-started.md' },
      { slug: 'demo', source: 'docs/demo.md', nav: 'Try the demo' },
      { slug: 'faq', source: 'site/content/faq.md' },
    ],
  },
  {
    title: 'Run it',
    pages: [
      { slug: 'self-hosting', source: 'site/content/self-hosting.md' },
      { slug: 'configuration', source: 'site/content/configuration.md' },
      { slug: 'deployment', source: 'docs/deployment.md', nav: 'Deployment reference' },
      { slug: 'credentials', source: 'docs/credentials.md', nav: 'Store credentials' },
      { slug: 'releasing', source: 'docs/releasing.md', nav: 'Releasing Kiln', optional: true },
    ],
  },
  {
    title: 'Use it',
    pages: [
      { slug: 'ai-features', source: 'docs/ai-features.md', nav: 'AI features' },
      { slug: 'alerts', source: 'docs/alerts.md' },
      { slug: 'chat-integrations', source: 'docs/chat-integrations.md', nav: 'Slack and Teams' },
      { slug: 'mcp', source: 'docs/mcp.md', nav: 'Connect an AI assistant' },
      { slug: 'troubleshooting-analytics', source: 'docs/troubleshooting-analytics.md', nav: 'Analytics troubleshooting' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'api', source: 'site/content/api.md', nav: 'API overview' },
      { slug: 'openapi', source: 'docs/api/openapi.md', nav: 'OpenAPI description' },
      { slug: 'architecture', source: 'docs/architecture.md' },
    ],
  },
  {
    title: 'Project',
    pages: [
      { slug: 'security', source: 'SECURITY.md', nav: 'Security' },
      { slug: 'contributing', source: 'CONTRIBUTING.md' },
      { slug: 'website', source: 'docs/website.md', nav: 'This website' },
    ],
  },
];
