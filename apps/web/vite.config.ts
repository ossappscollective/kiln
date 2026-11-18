import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    // The API runs separately in development. Do not use the string shorthand here: it turns on
    // changeOrigin, which rewrites Host to :8787 while the browser's Origin stays :5173, and the
    // server's same-origin check then rejects every write as a cross-site request.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
});
