const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toast', {
  confirm: () => ipcRenderer.send('toast:confirm'),
  cancel: () => ipcRenderer.send('toast:cancel'),
  onShow: (cb) => ipcRenderer.on('toast:show', (_e, data) => cb(data)),
});