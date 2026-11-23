import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const executable = resolve(root,'native/desktop-pilot/target/release/lolping-desktop-pilot.exe');
const binary = await readFile(executable);
const pe = binary.readUInt32LE(0x3c);
if (binary.readUInt16LE(pe + 24 + 68) !== 2) throw new Error('Release app would open a console at login');
const data = resolve(root,'out/desktop-pilot/smoke-startup');
await mkdir(data,{ recursive:true });
await writeFile(resolve(data,'settings.json'),JSON.stringify({ launchAtStartup:true,rejoinRoom:false,allowInternet:false }));
const base = { ...process.env, LOLPING_PILOT_STARTUP_SMOKE:'1',LOLPING_PILOT_SIMULATE:'1',LOLPING_PILOT_DATA_DIR:data,LOLPING_PILOT_SECONDS:'30' };
for (const key of ['LOLPING_PILOT_SMOKE','LOLPING_PILOT_ROOM_SMOKE','LOLPING_PILOT_CHAT_SMOKE','LOLPING_PILOT_PANEL_SMOKE',
  'LOLPING_PILOT_DISPLAY_SMOKE','LOLPING_PILOT_DEMO','LOLPING_PILOT_BENCHMARK','LOLPING_PILOT_SETTINGS']) delete base[key];
async function run(hidden) {
  const env = { ...base, ...(hidden ? { LOLPING_PILOT_SECONDS:'5' } : { LOLPING_PILOT_SETTINGS:'1' }) };
  const child = spawn(executable,hidden ? ['--hidden'] : [],
    { cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe'] });
  let log = '';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',(bytes) => { log += bytes; process.stdout.write(bytes); });
  const code = await new Promise((done,reject) => { child.once('exit',done); child.once('error',reject); });
  if (code !== 0 || !(hidden ? log.includes('hidden=true, settings=false') && log.includes('Pilot ready:') : log.includes('Pilot startup smoke: passed'))) {
    throw new Error(`Startup smoke failed: hidden=${hidden}, exit=${code}`);
  }
}
await run(false);
await run(true);
console.log('Isolated startup registration, settings transactions and hidden launch passed');
