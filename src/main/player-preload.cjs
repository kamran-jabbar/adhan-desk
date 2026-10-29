const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adhanPlayer', Object.freeze({
  getConfig: () => ipcRenderer.invoke('player:config'),
  report: (type, message) => ipcRenderer.send('player:report', { type, message }),
  stop: () => ipcRenderer.invoke('player:stop')
}));
