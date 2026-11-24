// Mobile menu: a button that shows and hides the navigation list. Without JavaScript the list is always visible.
export function initNav() {
  const button = document.querySelector('[data-menu-toggle]');
  const nav = document.getElementById('site-nav');
  if (!button || !nav) return;
  const set = (open) => {
    nav.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => set(!nav.classList.contains('open')));
  nav.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) set(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      set(false);
      button.focus();
    }
  });
}
