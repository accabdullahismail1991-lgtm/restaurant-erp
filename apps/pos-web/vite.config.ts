import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Offline-first (Phase 8, docs/ARCHITECTURE.md) adds vite-plugin-pwa's
// service-worker/manifest config here later -- this stays a plain online
// build until that phase, per the pos-web README's own staging note.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
