// The search index: built at build time from page titles and headings, queried in the browser by
// site/static/js/search.js. Shape:
//   { entries: [[title, url, pageTitle], ...], terms: { token: [entryIndex, ...] } }
// `url` is relative to the site root (the browser prefixes its own root).

export function tokenize(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * @param {{ title: string, route: string, description?: string, headings: {level:number,text:string,id:string}[] }[]} pages
 */
export function buildSearchIndex(pages) {
  const entries = [];
  const terms = new Map();
  const add = (title, url, pageTitle, extraText = '') => {
    const index = entries.length;
    entries.push([title, url, pageTitle]);
    for (const token of new Set(tokenize(`${title} ${extraText}`))) {
      if (!terms.has(token)) terms.set(token, []);
      terms.get(token).push(index);
    }
  };
  for (const page of pages) {
    add(page.title, page.route, page.title, page.description ?? '');
    for (const h of page.headings) {
      if (h.level < 2 || h.level > 3) continue;
      add(h.text, `${page.route}#${h.id}`, page.title, page.title);
    }
  }
  const sorted = Object.fromEntries([...terms.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { entries, terms: sorted };
}
