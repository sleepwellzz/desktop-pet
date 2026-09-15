const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onInit: (cb) => ipcRenderer.on('pet:init', (_e, v) => cb(v)),
  onHud: (cb) => ipcRenderer.on('pet:hud', (_e, v) => cb(v)),
  sendMask: (w, h, data) => ipcRenderer.send('pet:mask', { w, h, data }),
  reportClick: (x, y) => ipcRenderer.send('pet:clicked', { x, y, t: Date.now() }),
});
