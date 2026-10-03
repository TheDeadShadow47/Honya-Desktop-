// Sandboxed preload: exposes one narrow invoke() bridge plus two main->renderer event streams.
// No Node APIs reach the renderer.
import { contextBridge, ipcRenderer } from 'electron';

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('honya', {
  invoke: (channel, ...args) => ipcRenderer.invoke('honya:invoke', channel, args),
  onDownloadState: on('honya:downloadState'),
  onLibraryUpdate: on('honya:libraryUpdate'),
  platform: process.platform,
});