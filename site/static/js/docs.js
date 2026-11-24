// Loaded on documentation pages.
import { initSearch } from './search.js';
import { initToc } from './toc.js';

initSearch();
initToc();

// On a narrow screen the documentation menu starts closed, so the article is the first thing you see.
const menu = document.querySelector('.docs-side details');
if (menu && typeof matchMedia === 'function' && matchMedia('(max-width: 59.99rem)').matches) menu.open = false;
