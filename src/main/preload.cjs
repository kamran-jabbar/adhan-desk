const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adhan', Object.freeze({
  getState: () => ipcRenderer.invoke('adhan:getState'),
  saveSettings: patch => ipcRenderer.invoke('adhan:saveSettings', patch),
  sync: () => ipcRenderer.invoke('adhan:sync'),
  importAudio: () => ipcRenderer.invoke('adhan:importAudio'),
  importFajrAudio: () => ipcRenderer.invoke('adhan:importFajrAudio'),
  clearFajrAudio: () => ipcRenderer.invoke('adhan:clearFajrAudio'),
  testFajrAudio: () => ipcRenderer.invoke('adhan:testFajrAudio'),
  useDefaultAudio: () => ipcRenderer.invoke('adhan:useDefaultAudio'),
  openAudioCredits: () => ipcRenderer.invoke('adhan:openAudioCredits'),
  openSupport: () => ipcRenderer.invoke('adhan:openSupport'),
  testAudio: () => ipcRenderer.invoke('adhan:testAudio'),
  stopAudio: () => ipcRenderer.invoke('adhan:stopAudio'),
  openSource: () => ipcRenderer.invoke('adhan:openSource'),
  openRecording: () => ipcRenderer.invoke('adhan:openRecording'),
  quit: () => ipcRenderer.invoke('adhan:quit'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('adhan:state', listener);
    return () => ipcRenderer.removeListener('adhan:state', listener);
  }
}));
