const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('immersiveAPI', {
  onUpdate:       (cb) => ipcRenderer.on('immersive:update',   (_, d) => cb(d)),
  onLyrics:       (cb) => ipcRenderer.on('immersive:lyrics',   (_, d) => cb(d)),
  onProgress:     (cb) => ipcRenderer.on('immersive:progress', (_, d) => cb(d)),
  onQueue:        (cb) => ipcRenderer.on('immersive:queue',    (_, d) => cb(d)),
  action:         (type) => ipcRenderer.send('immersive:action', type),
  close:          ()     => ipcRenderer.send('immersive:close'),
  setMouseIgnore: (v)    => ipcRenderer.send('immersive:mouse-ignore', v),
  onGlassMode:    (cb)   => ipcRenderer.on('immersive:glass-mode', (_, m) => cb(m)),
});
