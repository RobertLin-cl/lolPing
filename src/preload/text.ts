import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TextApi } from '../shared/ipc';

const api: TextApi = {
  // Inlined: a sandboxed preload can require electron, but not a generated sibling chunk.
  submit: (text) => ipcRenderer.invoke('text:submit', text),
  hide: () => ipcRenderer.send('text:hide'),
  strings: () => ipcRenderer.invoke('text:strings'),
  lines: () => ipcRenderer.invoke('text:lines'),
  onLines: (cb) => {
    const handler = (_e: IpcRendererEvent, lines: Parameters<typeof cb>[0]) => cb(lines);
    ipcRenderer.on('text:linesChanged', handler);
    return () => ipcRenderer.removeListener('text:linesChanged', handler);
  },
  hover: (on) => ipcRenderer.send('text:hover', on === true),
  names: () => ipcRenderer.invoke('text:names'),
};

contextBridge.exposeInMainWorld('textApi', api);
