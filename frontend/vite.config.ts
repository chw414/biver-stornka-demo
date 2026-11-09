import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ten sam origin co API (jak na produkcji za reverse proxy) — cookies SameSite=Strict działają w dev
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    // multi-page: klient (index.html) i panel admina (admin/index.html, kolejny krok) jako osobne paczki —
    // klient nie pobiera kodu panelu
    rollupOptions: { input: { booking: 'index.html', admin: 'admin/index.html' } },
    sourcemap: false,
  },
});
