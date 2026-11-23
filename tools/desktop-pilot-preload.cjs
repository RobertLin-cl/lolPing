const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['pilot_bootstrap', 'pilot_ready', 'pilot_idle', 'pilot_stop', 'pilot_placed']);
contextBridge.exposeInMainWorld('pilotHost', {
  invoke(command, args) {
    if (!commands.has(command)) throw new Error('Unknown pilot command');
    return ipcRenderer.invoke(command, args);
  },
  listen(event, cb) {
    if (!['pilot-input', 'pilot-settings', 'pilot-status', 'pilot-placed', 'pilot-preview', 'pilot-room-input', 'pilot-room-gone', 'pilot-room', 'pilot-room-notice', 'pilot-chat-line', 'pilot-summoner'].includes(event)) throw new Error('Unknown pilot event');
    const listener = (_event, payload) => cb({ payload });
    ipcRenderer.on(event, listener);
    return Promise.resolve(() => ipcRenderer.removeListener(event, listener));
  },
});
