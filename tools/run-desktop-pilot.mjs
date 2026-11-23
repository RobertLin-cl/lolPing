import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// PowerShell does not wait for a GUI-subsystem binary or reliably capture its smoke output.
const child = spawn(resolve(import.meta.dirname,'../native/desktop-pilot/target/release/lolping-desktop-pilot.exe'), [],
  { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); });
