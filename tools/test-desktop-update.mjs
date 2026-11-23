import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const root = resolve(import.meta.dirname,'..');
const output = join(root,'out/desktop-pilot/package');
const manifestBytes = await readFile(join(output,'desktop-pilot-update.json'));
const manifest = JSON.parse(manifestBytes);
const installer = join(output,manifest.installer);
const installerBytes = await readFile(installer);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (manifest.sha256 !== hash(installerBytes) || manifest.size !== installerBytes.length) throw new Error('Package manifest is stale');
const data = join(root,`out/desktop-pilot/update smoke-${process.pid}`);
const installed = join(data,'installed');
const inside = relative(join(root,'out/desktop-pilot'),installed);
if (inside.startsWith('..') || resolve(installed) === root) throw new Error('Test installation is outside the workspace output');
await mkdir(data,{recursive:true});
await writeFile(join(data,'settings.json'),JSON.stringify({ autoUpdateCheck:false,rejoinRoom:false,allowInternet:false,displayName:'UpdateSmoke' }));
const run = async (exe,args,options = {}) => {
  const child = spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
  let log = '';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',(bytes) => { log += bytes; process.stdout.write(bytes); });
  const code = await new Promise((done,reject) => { child.once('exit',done); child.once('error',reject); });
  return {code,log};
};
const missing = await run(installer,['/S','/TEST','/TEST_NO_WEBVIEW',`/D=${join(data,'missing-runtime')}`],{windowsVerbatimArguments:true});
if (missing.code !== 4 || await stat(join(data,'missing-runtime/lolping-desktop-pilot.exe')).then(() => true,() => false)) throw new Error('Missing runtime changed the install');
const initial = await run(installer,['/S','/TEST',`/D=${installed}`],{windowsVerbatimArguments:true});
if (initial.code !== 0) throw new Error(`Initial test install failed (${initial.code})`);
await writeFile(join(installed,'keep.txt'),'user file must survive upgrade and uninstall');
await writeFile(join(installed,'lolping-desktop-pilot.exe'),'old executable fixture');
const lockScript = "$file = [IO.File]::Open($env:LOLPING_INSTALL_TEST_LOCK, 'Open', 'Read', 'Read'); [Console]::WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::ReadLine(); $file.Dispose()";
const lock = spawn('pwsh.exe',['-NoProfile','-Command',lockScript],{windowsHide:true,stdio:['pipe','pipe','pipe'],
  env:{...process.env,LOLPING_INSTALL_TEST_LOCK:join(installed,'hook-helper.exe')}});
const unlocked = new Promise((done,reject) => { lock.once('exit',done); lock.once('error',reject); });
await new Promise((done,reject) => {
  lock.stdout.on('data',(bytes) => { if (String(bytes).includes('locked')) done(); });
  lock.once('exit',() => reject(new Error('Could not lock the installed helper'))); lock.once('error',reject);
});
try {
  const failed = await run(installer,['/S','/TEST',`/D=${installed}`],{windowsVerbatimArguments:true});
  if (failed.code === 0 || (await readFile(join(installed,'lolping-desktop-pilot.exe'),'utf8')) !== 'old executable fixture') {
    throw new Error('Failed upgrade did not restore the old executable');
  }
} finally { lock.stdin.end('\n'); await unlocked; }
let mode = 'empty'; let downloads = 0; let refusedBeforeRetry = false;
const server = createServer(async (req,res) => {
  try {
    const path = new URL(req.url,'http://127.0.0.1').pathname;
    if (path.startsWith('/scenario/')) {
      mode = path.slice('/scenario/'.length);
      if (mode === 'healthy') {
        refusedBeforeRetry = (await readFile(join(installed,'lolping-desktop-pilot.exe'),'utf8')) === 'old executable fixture';
      }
      res.writeHead(200); res.end('ok'); return;
    }
    if (path === '/releases/latest') {
      if (req.headers.accept !== 'application/vnd.github+json') { res.writeHead(406); res.end(); return; }
      const asset = (name,bytes) => ({ name,size:bytes.length,digest:`sha256:${hash(bytes)}`,browser_download_url:`${origin}assets/${name}` });
      const assets = mode === 'empty' ? [{ name:`lolPing-Setup-${manifest.version}.exe` }]
        : [asset('desktop-pilot-update.json',manifestBytes),asset(manifest.installer,installerBytes)];
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({draft:false,prerelease:false,tag_name:`v${manifest.version}`,assets})); return;
    }
    if (path === '/assets/desktop-pilot-update.json') {
      if (mode === 'redirect') { res.writeHead(302,{Location:'http://127.0.0.1:1/not-the-test-origin'}); res.end(); return; }
      res.writeHead(200,{'Content-Length':manifestBytes.length});
      res.end(mode === 'bad-manifest' ? Buffer.alloc(manifestBytes.length,32) : manifestBytes); return;
    }
    if (path === `/assets/${manifest.installer}`) {
      downloads++;
      const bytes = Buffer.from(installerBytes);
      if (mode === 'bad-installer') bytes[bytes.length - 1] ^= 1;
      res.writeHead(200,{'Content-Length':bytes.length}); res.end(bytes); return;
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((done) => server.listen(0,'127.0.0.1',done));
const origin = `http://127.0.0.1:${server.address().port}/`;
const env = {...process.env,LOLPING_PILOT_UPDATE_SMOKE:'1',LOLPING_PILOT_UPDATE_ORIGIN:origin,LOLPING_PILOT_DATA_DIR:data,
  LOLPING_PILOT_SIMULATE:'1',LOLPING_PILOT_SETTINGS:'1',LOLPING_PILOT_SECONDS:'100'};
for (const key of ['LOLPING_PILOT_SMOKE','LOLPING_PILOT_ROOM_SMOKE','LOLPING_PILOT_CHAT_SMOKE','LOLPING_PILOT_PANEL_SMOKE',
  'LOLPING_PILOT_STARTUP_SMOKE','LOLPING_PILOT_DISPLAY_SMOKE','LOLPING_PILOT_BENCHMARK','LOLPING_PILOT_DEMO']) delete env[key];
async function until(check,label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done,50));
  }
  throw new Error(`Package smoke timed out: ${label}`);
}
try {
  const result = await run(join(root,'native/desktop-pilot/target/release/lolping-desktop-pilot.exe'),[],{env});
  if (result.code !== 0 || !result.log.includes('Pilot update smoke: passed')) throw new Error(`Update page failed (${result.code})`);
  await until(async () => hash(await readFile(join(installed,'lolping-desktop-pilot.exe'))) === hash(await readFile(join(output,'app/lolping-desktop-pilot.exe'))),'verified installer upgrade');
  await until(async () => hash(await readFile(join(installed,'hook-helper.exe'))) === hash(await readFile(join(output,'app/hook-helper.exe'))),'bundled helper upgrade');
  if (!refusedBeforeRetry || downloads !== 2 || (await readdir(join(data,'updates'))).some((name) => name.endsWith('.part'))) throw new Error('Download verification or cleanup failed');
  if ((await readFile(join(installed,'keep.txt'),'utf8')) !== 'user file must survive upgrade and uninstall') throw new Error('Upgrade changed an unrelated file');
  const launchEnv = {...env,LOLPING_PILOT_SECONDS:'3',LOLPING_PILOT_DATA_DIR:join(data,'launch-data')};
  for (const key of ['LOLPING_PILOT_UPDATE_SMOKE','LOLPING_PILOT_UPDATE_ORIGIN','LOLPING_PILOT_SETTINGS']) delete launchEnv[key];
  const launched = await run(join(installed,'lolping-desktop-pilot.exe'),['--hidden'],{env:launchEnv});
  if (launched.code !== 0 || !launched.log.includes('"type":"ready","version":8')) throw new Error('Installed copy could not start its bundled helper');
  await run(join(installed,'Uninstall.exe'),['/S']);
  await until(async () => !(await stat(join(installed,'lolping-desktop-pilot.exe')).then(() => true,() => false)),'isolated uninstall');
  if ((await readFile(join(installed,'keep.txt'),'utf8')) !== 'user file must survive upgrade and uninstall') throw new Error('Uninstall removed an unrelated file');
  if (JSON.parse(await readFile(join(data,'settings.json'),'utf8')).displayName !== 'UpdateSmoke') throw new Error('Upgrade changed profile data');
  console.log('Isolated install, locked-file rollback, rejected tampering/redirects, verified update, bundled launch and uninstall passed');
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
