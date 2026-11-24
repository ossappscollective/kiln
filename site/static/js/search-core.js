// Query a search index built by site/lib/search-index.mjs. Pure functions: no DOM, tested with node --test.
export function tokenize(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Every query word must match (as a prefix) a term of the entry. Exact words and title hits rank higher, and
 * whole-page entries rank above headings.
 * @returns {{ title: string, url: string, page: string }[]}
 */
export function search(index, query, limit = 8) {
  const words = tokenize(query);
  if (words.length === 0) return [];
  const terms = Object.keys(index.terms);
  let scores = null;
  for (const word of words) {
    const hit = new Map();
    for (const term of terms) {
      if (!term.startsWith(word)) continue;
      const weight = term === word ? 3 : 1;
      for (const entry of index.terms[term]) hit.set(entry, Math.max(hit.get(entry) ?? 0, weight));
    }
    if (scores === null) scores = hit;
    else {
      for (const entry of [...scores.keys()]) {
        if (hit.has(entry)) scores.set(entry, scores.get(entry) + hit.get(entry));
        else scores.delete(entry);
      }
    }
    if (scores.size === 0) return [];
  }
  const lowered = query.trim().toLowerCase();
  return [...scores.entries()]
    .map(([entry, score]) => {
      const [title, url, page] = index.entries[entry];
      const pageLevel = !url.includes('#');
      const exactTitle = title.toLowerCase().includes(lowered) ? 2 : 0;
      return { title, url, page, score: score + exactTitle + (pageLevel ? 1 : 0), entry };
    })
    .sort((a, b) => b.score - a.score || a.entry - b.entry)
    .slice(0, limit)
    .map(({ title, url, page }) => ({ title, url, page }));
}
