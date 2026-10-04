import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3180';

// The PDF viewer loads pdf.js's worker from pdfjs-dist, a dependency of react-pdf that pnpm
// doesn't expose to the app. Resolving it through react-pdf keeps the worker the exact version
// react-pdf runs (a mismatched worker refuses to start).
const fromReactPdf = createRequire(createRequire(import.meta.url).resolve('react-pdf'));
const pdfjsDist = path.dirname(fromReactPdf.resolve('pdfjs-dist/package.json'));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      'pdfjs-dist': pdfjsDist,
    },
  },
  build: {
    // pdf.js's main module is ~620 kB minified on its own and can't be split; it is loaded lazily,
    // only by the invoice page's viewer. Every other chunk stays under Vite's default 500 kB.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // pdf.js's worker ships as .mjs. nginx (the web image) maps only .js to JavaScript, and a
        // module worker served as application/octet-stream with nosniff is refused: emit it as .js.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.mjs'))
            ? 'assets/[name]-[hash].js'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Fixed port (fail instead of drifting) so it never collides with other projects' dev servers.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
});
