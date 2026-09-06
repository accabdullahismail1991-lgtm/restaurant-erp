import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Phase 8 (docs/ARCHITECTURE.md, Offline-first): the service worker here
// only precaches the app shell (JS/CSS/HTML) so a reload while offline
// still loads the app -- it deliberately does NOT cache API responses.
// Data the POS screen needs offline (menu items, recipes, balances) is
// cached separately in IndexedDB via src/offline/store.ts, which gives us
// explicit control over staleness instead of workbox's generic runtime
// caching rules.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'كاشير المطعم',
        short_name: 'الكاشير',
        description: 'نقطة بيع أونلاين أولاً مع دعم العمل بدون اتصال',
        lang: 'ar',
        dir: 'rtl',
        start_url: '/',
        display: 'standalone',
        background_color: '#faf7f0',
        theme_color: '#2f5233',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Explicitly app-shell only -- no navigateFallback games with API
        // routes, and no runtimeCaching entries for /orders, /items, etc.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
      },
    }),
  ],
  server: { port: 5173 },
});
