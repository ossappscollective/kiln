// Marks the heading being read in the in-page contents (aria-current="true").
export function initToc() {
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (!links.length || typeof IntersectionObserver !== 'function') return;
  const byId = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const headings = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const visible = new Set();
  const update = () => {
    const first = headings.find((h) => visible.has(h.id));
    for (const a of links) a.removeAttribute('aria-current');
    if (first) byId.get(first.id)?.setAttribute('aria-current', 'true');
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      update();
    },
    { rootMargin: '-72px 0px -65% 0px' },
  );
  for (const h of headings) observer.observe(h);
}
