const { contextBridge, ipcRenderer } = require('electron');

const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld('tubedeck', {
  // 'switch' kept as an alias so older renderer.js versions keep working
  requestSwitch: send('app:request-switch'),
  switch: send('app:request-switch'),
  back: send('nav:back'),
  forward: send('nav:forward'),
  reload: send('nav:reload'),
  minimize: send('win:minimize'),
  toggleMaximize: send('win:toggle-maximize'),
  close: send('win:close'),
  devtools: send('win:devtools'),
  requestState: send('app:ready'),
  onUpdate: (callback) => {
    ipcRenderer.on('app:update', (_event, state) => callback(state));
  },
});