import { mount } from 'svelte';
import './app.css';
import './styles/accents.css';
import './styles/tint.css';
import App from './App.svelte';
import { initI18n } from './lib/i18n/i18n.svelte.ts';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app element');

// Mount only once the person's language is loaded (English is bundled), so the first paint is never a row of keys.
// `initI18n` never rejects: a language that cannot be fetched leaves the app in English.
void initI18n().then(() => mount(App, { target }));
