import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as buildWeb } from 'vite';

if (process.platform !== 'win32') throw new Error('The desktop pilot currently targets Windows only');
const output = resolve('out/desktop-pilot');
await mkdir(output, { recursive: true });
const shared = join(output, 'shared.cjs');
await build({
  stdin: {
    contents: `export { desktopPilotSettings, desktopPilotRuntime } from './src/shared/desktopPilot';
      export { resolveLang, strings } from './src/shared/i18n';
      export { RELAYS } from './src/main/relays';`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: shared,
});
const { desktopPilotSettings, desktopPilotRuntime, resolveLang, strings, RELAYS } = createRequire(import.meta.url)(shared);
let raw = {};
try {
  raw = JSON.parse(await readFile(join(process.env.APPDATA ?? '', 'lolPing/settings.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('Could not load existing settings; using defaults:', error.message);
}
const settings = desktopPilotSettings({ ...raw, launchAtStartup: false });
const lang = resolveLang(settings.language, Intl.DateTimeFormat().resolvedOptions().locale);
const text = strings(lang, 'win');
await writeFile(join(output, 'bootstrap.json'), JSON.stringify({
  settings,
  relays: RELAYS,
  ...desktopPilotRuntime(settings, settings.enabledOnStart, lang),
  settingsLabel: text.traySettings,
  quit: text.trayQuit,
}));
await buildWeb({ configFile: resolve('tools/desktop-pilot.config.ts') });
console.log(`Desktop pilot frontend built at ${pathToFileURL(output)}`);
