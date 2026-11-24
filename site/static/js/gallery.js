// Screenshots gallery: opens a picture in a native <dialog> (Escape and the Close button work, focus goes back to the link),
// and keeps the pictures in step with the site's theme toggle (the <picture> alone follows only the system setting).
function siteTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark' || set === 'light') return set;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncPictures(root) {
  const dark = siteTheme() === 'dark';
  for (const pic of root.querySelectorAll('picture')) {
    const source = pic.querySelector('source[data-theme-source]');
    const img = pic.querySelector('img');
    if (!source || !img) continue;
    // 'all' always matches, 'not all' never: the toggle decides, whatever the system says.
    source.media = dark ? 'all' : 'not all';
    img.src = dark ? img.dataset.dark : img.dataset.light;
  }
}

export function initGallery() {
  const section = document.querySelector('[data-shots]');
  if (!section) return;
  syncPictures(section);
  new MutationObserver(() => syncPictures(section)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => syncPictures(section));

  const dialog = section.querySelector('dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return; // without it the links open the image itself
  const title = dialog.querySelector('#shots-dialog-title');
  const big = dialog.querySelector('[data-shot-big]');
  for (const link of section.querySelectorAll('a[data-shot]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const pic = link.querySelector('picture').cloneNode(true);
      const img = pic.querySelector('img');
      img.removeAttribute('loading');
      big.replaceChildren(pic);
      title.textContent = link.closest('figure').querySelector('figcaption').textContent;
      syncPictures(dialog);
      dialog.showModal();
    });
  }
  // A click on the backdrop (outside the dialog's box) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => big.replaceChildren());
}
