'use strict';
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { secureWindow } = require('./DesktopService.cjs');

// The player reports loading/playing/ended. Successful audio is never timed out.
class PlaybackService {
  constructor(base, callbacks, { testMode = false } = {}) {
    this.base = base; this.callbacks = callbacks; this.testMode = testMode;
    this.window = null; this.config = null; this.state = null;
  }
  isSender(event) { return this.window && event.sender === this.window.webContents && event.senderFrame?.url === this.base + 'player.html'; }
  changed() { this.callbacks.onChange(this.state); }
  async start({ prayer, eventId = null, mode, volume, videoId, audioName, audioPath }) {
    if (this.state) this.stop('Stopped for the next playback');
    if (mode === 'local' && (!audioPath || !fs.existsSync(audioPath))) throw new Error('Choose a local adhan recording, or restore the included recording.');
    this.config = { mode, volume, prayer, videoId, audioName };
    this.state = { prayer, eventId, startedAt: new Date().toISOString(), state: 'loading' };
    this.window = new BrowserWindow({
      width: 800, height: mode === 'local' ? 370 : 690, minWidth: 600,
      title: `Adhan · ${prayer}`, autoHideMenuBar: true, backgroundColor: '#f7f5ef',
      // Scheduled local audio runs quietly. A manual test shows the controls.
      show: mode === 'youtube' || prayer === 'Test',
      webPreferences: {
        preload: path.join(__dirname, '../player-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
      }
    });
    const window = this.window;
    if (this.testMode) window.webContents.setAudioMuted(true);
    secureWindow(window, this.base + 'player.html');
    window.on('closed', () => { if (this.window === window) { this.window = null; this.stop('Stopped'); } });
    window.webContents.on('render-process-gone', () => {
      if (this.window === window) { this.callbacks.onError('The audio player stopped unexpectedly. Test your audio before the next prayer.'); this.stop('Player failed'); }
    });
    this.callbacks.log(`${prayer} adhan loading (${mode}).`); this.changed();
    try { await window.loadURL(this.base + 'player.html'); }
    catch (error) { if (this.window === window) this.stop('Player failed'); throw error; }
  }
  report(data) {
    if (!this.state || !data) return;
    if (data.type === 'playing') {
      this.state.state = 'playing'; this.callbacks.log(`${this.state.prayer} adhan playing.`); this.changed();
    } else if (data.type === 'ended') this.stop('Completed');
    else if (data.type === 'error') {
      const message = String(data.message || 'Audio playback failed.').slice(0, 500);
      this.state.state = 'error'; this.callbacks.onError(message); this.changed();
      if (this.window && !this.window.isDestroyed()) this.window.show();
    }
  }
  stop(reason = 'Stopped') {
    if (!this.state) return;
    const prayer = this.state.prayer; const window = this.window;
    this.state = null; this.config = null; this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
    this.callbacks.log(`${prayer} adhan: ${reason.toLowerCase()}.`); this.changed();
  }
}
module.exports = { PlaybackService };
