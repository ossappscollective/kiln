// Theme toggle. The first paint is handled by a tiny inline script in <head> (see site/lib/render.mjs), which sets
// data-theme from localStorage before the page is drawn. Without a stored choice the system setting decides (CSS).
const KEY = 'kiln-site-theme';

function systemDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function current() {
  return document.documentElement.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light');
}

function label(button) {
  const next = current() === 'dark' ? 'light' : 'dark';
  button.setAttribute('aria-label', `Switch to ${next} theme`);
  button.setAttribute('title', `Switch to ${next} theme`);
}

export function initTheme() {
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    label(button);
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // storage can be blocked (private mode, policy): the choice then lasts for this page view only
      }
      label(button);
    });
  }
}
