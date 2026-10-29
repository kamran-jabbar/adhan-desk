'use strict';
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { secureWindow } = require('./DesktopService.cjs');
const { SystemAudioService } = require('./SystemAudioService.cjs');

// The player reports loading/playing/ended. Successful audio is never timed out.
class PlaybackService {
  constructor(base, callbacks, { testMode = false } = {}) {
    this.base = base; this.callbacks = callbacks; this.testMode = testMode;
    this.window = null; this.config = null; this.state = null;
    this.audioPath = null; this.audioLease = null; this.systemAudio = new SystemAudioService(); this.queue = Promise.resolve();
  }
  isSender(event) { return this.window && event.sender === this.window.webContents && event.senderFrame?.url === this.base + 'player.html'; }
  changed() { this.callbacks.onChange(this.state); }
  enqueue(operation) {
    const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task;
  }
  start(options) {
    return this.enqueue(async () => {
      try { await this.startNow(options); }
      catch (error) { await this.stopNow('Player failed'); throw error; }
    });
  }
  async startNow({ prayer, eventId = null, mode, volume, videoId, audioName, audioPath, isTest = false, unmuteForAdhan = false }) {
    if (this.state) await this.stopNow('Stopped for the next playback');
    if (mode === 'local' && (!audioPath || !fs.existsSync(audioPath))) throw new Error('Choose a local adhan recording, or restore the included recording.');
    this.audioPath = audioPath;
    this.config = { mode, volume, prayer, videoId, audioName, isTest };
    this.state = { prayer, eventId, startedAt: new Date().toISOString(), state: 'loading' };
    this.window = new BrowserWindow({
      width: 800, height: mode === 'local' ? 370 : 690, minWidth: 600,
      title: `Adhan · ${prayer}`, autoHideMenuBar: true, backgroundColor: '#f7f5ef',
      // Scheduled local audio runs quietly. A manual test shows the controls.
      show: mode === 'youtube' || prayer === 'Test' || isTest,
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
    if (unmuteForAdhan && !this.testMode) {
      try { this.audioLease = await this.systemAudio.acquire(); }
      catch (error) { this.callbacks.onError(`System audio could not be changed: ${error.message}`); }
    }
    try { await window.loadURL(this.base + 'player.html'); }
    catch (error) { if (this.window === window) await this.stopNow('Player failed'); throw error; }
  }
  report(data) {
    if (!this.state || !data) return;
    if (data.type === 'playing') {
      this.state.state = 'playing'; this.callbacks.log(`${this.state.prayer} adhan playing.`); this.changed();
    } else if (data.type === 'ended') this.stop('Completed');
    else if (data.type === 'error') {
      const message = String(data.message || 'Audio playback failed.').slice(0, 500);
      this.state.state = 'error'; this.callbacks.onError(message); this.changed();
      this.enqueue(() => this.releaseSystemAudio());
      if (this.window && !this.window.isDestroyed()) this.window.show();
    }
  }
  stop(reason = 'Stopped') { return this.enqueue(() => this.stopNow(reason)); }
  async releaseSystemAudio() {
    const lease = this.audioLease; this.audioLease = null;
    if (lease) {
      try { await this.systemAudio.release(lease); }
      catch (error) { this.callbacks.onError(`System audio could not be restored: ${error.message}`); this.changed(); }
    }
  }
  async stopNow(reason = 'Stopped') {
    if (!this.state) return;
    const prayer = this.state.prayer; const window = this.window;
    this.state = null; this.config = null; this.window = null; this.audioPath = null;
    if (window && !window.isDestroyed()) window.destroy();
    this.callbacks.log(`${prayer} adhan: ${reason.toLowerCase()}.`); this.changed();
    await this.releaseSystemAudio();
  }
}
module.exports = { PlaybackService };
