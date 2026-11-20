const { app, BrowserWindow, ipcMain, protocol, net, screen, Menu, Tray } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged(['pilot', 'lolping'].map((scheme) => ({ scheme, privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} })));
const bootstrap = JSON.parse(readFileSync(resolve('out/desktop-pilot/bootstrap.json'), 'utf8'));
const windows = [];
const ready = new Set();
let helper;
let tray;
let exiting = false;

app.whenReady().then(() => {
  const root = resolve('out/desktop-pilot/web');
  protocol.handle('pilot', (request) => {
    const path = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`);
    if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
  protocol.handle('lolping', (request) => {
    const match = /^\/([0-9a-f]{32})\.(webp|hd|anim|sound)$/.exec(new URL(request.url).pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const [, hash, kind] = match;
    const files = kind === 'hd' ? [`${hash}.hd.webp`, `${hash}.webp`]
      : kind === 'anim' ? [`${hash}.anim.gif`, `${hash}.anim.webp`, `${hash}.webp`]
        : kind === 'sound' ? ['ogg', 'mp3', 'wav'].map((ext) => `${hash}.sound.${ext}`) : [`${hash}.webp`];
    const { existsSync } = require('node:fs');
    const file = files.map((name) => resolve(process.env.APPDATA, 'lolPing/emotes', name)).find((p) => existsSync(p));
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 });
  });
  const displays = screen.getAllDisplays().map((d, id) => {
    const origin = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    return { id, scale: d.scaleFactor, dip: d.bounds, phys: {
      ...origin, width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor),
    } };
  });
  const slotFor = (event) => {
    const slot = windows.find((slot) => slot.win.webContents.id === event.sender.id);
    if (!slot) throw new Error('Unknown overlay');
    return slot;
  };
  ipcMain.handle('pilot_bootstrap', (event) => ({
    displayId: slotFor(event).display.id, displays, settings: bootstrap.settings, revision: 0,
    status: { enabled: bootstrap.config.enabled, helper: 'starting' }, demo: Boolean(process.env.LOLPING_PILOT_DEMO),
  }));
  ipcMain.handle('pilot_stop', () => app.quit());
  ipcMain.handle('pilot_placed', (event, { kind }) => {
    const displayId = slotFor(event).display.id;
    if (kind !== 'ping' && kind !== 'emote') throw new Error('Unknown wheel');
    for (const { win } of windows) win.webContents.send('pilot-placed', JSON.stringify({ displayId, kind }));
  });
  ipcMain.handle('pilot_idle', (event, { idle }) => {
    const { win, display } = slotFor(event);
    const bounds = { ...display.dip, height: display.dip.height - 1 };
    const candidates = [
      { ...bounds, y: bounds.y - bounds.height + 1 },
      { ...bounds, y: display.dip.y + display.dip.height - 1 },
      { ...bounds, x: bounds.x - bounds.width + 1 },
      { ...bounds, x: display.dip.x + display.dip.width - 1 },
    ];
    const parked = candidates.find((r) => !displays.some((d) => d.id !== display.id
      && r.x < d.dip.x + d.dip.width && d.dip.x < r.x + r.width
      && r.y < d.dip.y + d.dip.height && d.dip.y < r.y + r.height));
    if (idle && !parked) return win.hide();
    win.setBounds(idle ? parked : bounds);
    if (!idle) { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); }
  });
  ipcMain.handle('pilot_ready', (event) => {
    ready.add(slotFor(event).display.id);
    const snapshot = { settings: bootstrap.settings, revision: 0,
      status: { enabled: bootstrap.config.enabled, helper: 'running' } };
    if (ready.size !== displays.length || helper) return snapshot;
    helper = spawn(resolve('native/hook-helper/build/hook-helper.exe'), process.env.LOLPING_PILOT_SIMULATE ? ['--simulate'] : [], {
      stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    });
    helper.on('error', (error) => { console.error(error); app.quit(); });
    helper.on('exit', () => { if (!exiting) app.quit(); });
    helper.stdin.on('error', () => app.quit());
    helper.stdin.write(JSON.stringify(bootstrap.config) + '\n');
    createInterface({ input: helper.stdout }).on('line', (line) => {
      console.log(`helper: ${line}`);
      for (const { win } of windows) if (!win.isDestroyed()) win.webContents.send('pilot-input', line);
    });
    console.log(`Pilot ready: ${displays.length} displays`);
    return snapshot;
  });
  tray = new Tray(resolve('build/icon.ico'));
  tray.setContextMenu(Menu.buildFromTemplate([{ label: bootstrap.quit, click: () => app.quit() }]));
  for (const display of displays) {
    const win = new BrowserWindow({
      ...display.dip, height: display.dip.height - 1,
      transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true,
      hasShadow: false, alwaysOnTop: true, show: false,
      webPreferences: { preload: resolve('tools/desktop-pilot-preload.cjs'),
        backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
    });
    windows.push({ win, display });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.once('ready-to-show', () => win.showInactive());
    win.webContents.on('render-process-gone', () => app.quit());
    win.webContents.on('console-message', (event) => console.log(`renderer: ${event.message}`));
    void win.loadURL('pilot://app/overlay/index.html');
  }
  const seconds = Number(process.env.LOLPING_PILOT_SECONDS);
  if (seconds > 0) setTimeout(() => app.quit(), seconds * 1000);
});
app.on('before-quit', () => { exiting = true; helper?.stdin?.end(); });
