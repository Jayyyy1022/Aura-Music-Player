const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniAPI', {
  onUpdate: (cb) => ipcRenderer.on('mini:update', (_, data) => cb(data)),
  onLyric:  (cb) => ipcRenderer.on('mini:lyric',  (_, text) => cb(text)),
  action:   (type) => ipcRenderer.send('mini:action', type),
});
