import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pruneAssets } from './pruneAssets';

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  publicDir: resolve('assets'),
  plugins: [react(), pruneAssets(), {
    name: 'desktop-pilot-entry',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/\/shared\/emotes$/.test(source) && !importer?.replaceAll('\\', '/').endsWith('/pilotEmotes.ts')) {
        return resolve('src/renderer/shared/pilotEmotes.ts');
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('src="./main.ts"', 'src="./pilot.ts"')
          .replace('src="./main.tsx"', 'src="./pilot.ts"')
          .replace('lolping://emotes', 'lolping://emotes http://lolping.localhost')
          .replace('connect-src \'self\' lolping://emotes', 'connect-src \'self\' lolping://emotes http://lolping.localhost')
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
      },
    },
  }],
  build: {
    outDir: resolve('out/desktop-pilot/web'),
    emptyOutDir: true,
    rollupOptions: { input: [resolve('src/renderer/overlay/index.html'), resolve('src/renderer/settings/index.html'), resolve('src/renderer/text/index.html'), resolve('src/renderer/panel/index.html')] },
  },
});
