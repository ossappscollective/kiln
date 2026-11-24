// Docs search: loads the index on first use, shows results under the input, "/" focuses the box.
import { search } from './search-core.js';

export function initSearch() {
  const input = document.getElementById('doc-search');
  const list = document.getElementById('search-results');
  const status = document.getElementById('search-status');
  if (!input || !list || !status) return;
  const root = new URL('../', import.meta.url);
  let index = null;
  let loading = null;
  let active = -1;

  const load = () => {
    loading ??= fetch(new URL('search-index.json', root))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        index = data;
      })
      .catch(() => {
        status.textContent = 'Search is not available right now.';
      });
    return loading;
  };

  const render = () => {
    list.replaceChildren();
    active = -1;
    const query = input.value.trim();
    if (!query || !index) {
      status.textContent = '';
      return;
    }
    const results = search(index, query);
    status.textContent = results.length
      ? `${results.length} result${results.length === 1 ? '' : 's'}`
      : 'No results';
    for (const result of results) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = new URL(result.url, root).href;
      a.textContent = result.title;
      if (result.page !== result.title) {
        const small = document.createElement('small');
        small.textContent = result.page;
        a.append(small);
      }
      li.append(a);
      list.append(li);
    }
  };

  const move = (delta) => {
    const links = [...list.querySelectorAll('a')];
    if (!links.length) return;
    active = (active + delta + links.length) % links.length;
    for (const [i, a] of links.entries()) a.classList.toggle('active', i === active);
    links[active].scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', load);
  input.addEventListener('input', async () => {
    await load();
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      const links = list.querySelectorAll('a');
      const target = links[active >= 0 ? active : 0];
      if (target) {
        event.preventDefault();
        location.href = target.href;
      }
    } else if (event.key === 'Escape') {
      input.value = '';
      render();
      input.blur();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    const details = input.closest('details');
    if (details) details.open = true;
    input.focus();
  });
}
