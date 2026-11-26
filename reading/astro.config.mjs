import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  output: 'static',
  integrations: [react()],
  markdown: { syntaxHighlight: false },
  vite: { optimizeDeps: { exclude: ['yoga-layout'] } },
});
