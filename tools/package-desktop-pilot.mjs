import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname,'..');
const output = join(root,'out/desktop-pilot/package');
const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) throw new Error('Invalid package version');
async function run(executable,args,extraEnv = {}) {
  const child = spawn(executable,args,{cwd:root,env:{...process.env,...extraEnv},stdio:'inherit',windowsHide:true});
  const code = await new Promise((done,reject) => { child.once('exit',done); child.once('error',reject); });
  if (code !== 0) throw new Error(`${executable} failed (${code})`);
}
if (!process.argv.includes('--skip-build')) {
  await run(process.execPath,['native/hook-helper/run.mjs','build']);
  await run(process.execPath,['tools/desktop-pilot.mjs'],{LOLPING_PILOT_PACKAGE_BUILD:'1'});
  await run(join(process.env.USERPROFILE,'.cargo/bin/cargo.exe'),['build','--release','--offline','--manifest-path','native/desktop-pilot/Cargo.toml']);
}
const built = join(root,'native/desktop-pilot/target/release/lolping-desktop-pilot.exe');
const probe = spawn(built,['--package-info'],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
let infoText = '';
probe.stdout.on('data',(bytes) => { infoText += bytes; });
const probeCode = await new Promise((done,reject) => { probe.once('exit',done); probe.once('error',reject); });
const info = probeCode === 0 ? JSON.parse(infoText) : null;
if (!info?.packageBuild || info.appId !== 'com.lolping.desktop-pilot' || info.version !== version) {
  throw new Error('Build a clean package before using --skip-build; developer preferences must not ship');
}
await mkdir(output,{recursive:true});
const directory = join(output,'app');
await mkdir(directory,{recursive:true});
const expected = new Set(['lolping-desktop-pilot.exe','hook-helper.exe','LICENSE','desktop-pilot.json']);
if ((await readdir(directory)).some((name) => !expected.has(name))) throw new Error('Package staging contains unexpected files; use a clean output directory');
const app = join(directory,'lolping-desktop-pilot.exe');
const helper = join(directory,'hook-helper.exe');
await copyFile(join(root,'native/desktop-pilot/target/release/lolping-desktop-pilot.exe'),app);
await copyFile(join(root,'native/hook-helper/build/hook-helper.exe'),helper);
for (const file of [app,helper]) {
  const bytes = await readFile(file);
  if (bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Package payloads must both target Windows x64');
}
await copyFile(join(root,'LICENSE'),join(directory,'LICENSE'));
await writeFile(join(directory,'desktop-pilot.json'),JSON.stringify({schema:1,appId:'com.lolping.desktop-pilot',runtime:'tauri',installed:false,test:0,version}));
const shared = join(output,'strings.cjs');
await build({stdin:{contents:"export { strings } from './src/shared/i18n';",resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:shared});
const { strings } = createRequire(import.meta.url)(shared);
const escape = (text) => text.replaceAll('$','$$').replaceAll('"','$\\"').replaceAll('\n','$\\r$\\n');
const translations = [['en','ENGLISH'],['zh-CN','SIMPCHINESE'],['zh-TW','TRADCHINESE']];
const stringsFile = join(output,'installer-strings.nsh');
await writeFile(stringsFile,translations.flatMap(([lang,nsis]) => {
  const t = strings(lang,'win');
  return [`LangString PilotQuitFirst \${LANG_${nsis}} "${escape(t.pilotInstallerQuitFirst)}"`,
    `LangString PilotWebView \${LANG_${nsis}} "${escape(t.pilotInstallerWebView)}"`,
    `LangString PilotWindows \${LANG_${nsis}} "${escape(t.pilotInstallerWindows)}"`];
}).join('\n'));
let makensis = process.env.LOLPING_MAKENSIS;
if (!makensis) {
  const cache = join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis-3.0.4.1');
  for (const folder of await readdir(cache,{withFileTypes:true})) {
    if (folder.isDirectory()) {
      const candidate = join(cache,folder.name,'Bin/makensis.exe');
      if (await stat(candidate).then((s) => s.isFile(),() => false)) { makensis = candidate; break; }
    }
  }
}
if (!makensis) throw new Error('NSIS 3 is required; set LOLPING_MAKENSIS to its makensis.exe');
const filename = `lolPing-Desktop-Pilot-Setup-${version}-x64.exe`;
const installer = join(output,filename);
await run(makensis,['/V2',`/DOUTPUT=${installer}`,`/DVERSION=${version}`,`/DAPP_EXE=${app}`,`/DHELPER_EXE=${helper}`,
  `/DLICENSE_FILE=${join(root,'LICENSE')}`,`/DSTRINGS_FILE=${stringsFile}`,join(root,'native/desktop-pilot/installer.nsi')]);
const bytes = await readFile(installer);
const manifest = {schema:1,appId:'com.lolping.desktop-pilot',runtime:'tauri',platform:'windows-x64',version,
  installer:filename,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
await writeFile(join(output,'desktop-pilot-update.json'),JSON.stringify(manifest,null,2));
console.log(`Desktop pilot package: ${installer}`);
