'use strict';
const { ipcMain, dialog, shell, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AppModel } = require('../models/AppModel.cjs');
const { validatePatch, validateSource, youtubeId } = require('../models/SettingsModel.cjs');
const { fetchTimetable } = require('../services/mawaqit.cjs');
const { dueEvents, dateInZone, buildEvents } = require('../services/scheduler.cjs');
const { DesktopService } = require('../services/DesktopService.cjs');
const { PlaybackService } = require('../services/PlaybackService.cjs');

const AUDIO_CREDITS = 'https://commons.wikimedia.org/wiki/File:The_Adhan_-_Muslim_Call_to_Prayer_-_Aaqib_Azeez.mp3';

// The controller coordinates models and services. It contains no DOM rendering.
class AppController {
  constructor(app, paths, { testMode = false } = {}) {
    this.app = app; this.paths = paths; this.testMode = testMode;
    this.model = new AppModel({ userDataPath: app.getPath('userData'), defaultAudioPath: paths.defaultAudioPath, isPackaged: app.isPackaged });
    this.desktop = new DesktopService(app, paths); this.player = null;
    this.syncPromise = null; this.lastSyncAttempt = 0; this.syncFailures = 0;
    this.retryAt = Infinity; this.lastLocalDate = null; this.intervals = [];
  }
  snapshot() { return this.model.snapshot(process.platform, this.app.getVersion()); }
  broadcast() { this.desktop.update(this.snapshot()); }
  async start() {
    this.model.load({ testMode: this.testMode });
    this.registerIPC();
    await this.desktop.start(() => this.player?.audioPath || this.model.audioPath, {
      onServerReady: base => {
        this.player = new PlaybackService(base, {
          log: (message, level) => this.model.log(message, level),
          onChange: state => { this.model.status.playback = state; this.model.persist(); this.broadcast(); },
          onError: message => { this.model.status.lastError = message; this.model.log(message, 'error'); this.desktop.notifyError(message); }
        }, { testMode: this.testMode });
      },
      toggle: () => this.saveSettings({ enabled: !this.model.settings.enabled }).catch(error => {
        this.model.status.lastError = error.message; this.broadcast();
      }),
      stop: () => this.player.stop()
    });
    if (this.model.firstRun && this.app.isPackaged && !this.testMode) {
      try { this.desktop.setAutoStart(this.model.settings.autoStart); }
      catch (error) { this.model.settings.autoStart = false; this.model.log(`Start at login needs attention: ${error.message}`, 'error'); }
      this.model.persist();
    }
    this.broadcast(); this.sync().catch(() => {});
    this.intervals.push(setInterval(() => this.tick(), 1000));
    this.intervals.push(setInterval(() => this.sync().catch(() => {}), 6 * 60 * 60 * 1000));
    powerMonitor.on('resume', () => {
      this.model.log('Computer resumed. Prayers more than 90 seconds late are skipped.');
      this.tick(); this.sync().catch(() => {});
    });
  }
  async sync(source = this.model.settings.sourceUrl) {
    if (this.syncPromise) { await this.syncPromise.catch(() => {}); if (source === this.model.settings.sourceUrl && !this.model.status.lastError) return this.snapshot(); }
    this.model.status.syncing = true; this.lastSyncAttempt = Date.now(); this.broadcast();
    this.syncPromise = (async () => {
      try {
        const timetable = await fetchTimetable(source);
        timetable.sourceUrl = source; buildEvents(timetable, this.model.settings.enabledPrayers);
        this.model.timetable = timetable; this.model.settings.sourceUrl = source; this.model.status.lastError = null;
        this.syncFailures = 0; this.retryAt = Infinity;
        this.model.log(`Timetable updated from ${timetable.name}.`); this.model.persist();
      } catch (error) {
        this.model.status.lastError = `Timetable refresh failed: ${error.message}. Cached dated times remain available.`;
        this.model.log(this.model.status.lastError, 'error');
        this.syncFailures++; this.retryAt = Date.now() + Math.min(15 * 60000, 60000 * 2 ** Math.min(this.syncFailures - 1, 4));
        throw new Error(this.model.status.lastError);
      } finally { this.model.status.syncing = false; this.syncPromise = null; this.broadcast(); }
    })();
    await this.syncPromise; return this.snapshot();
  }
  async saveSettings(patch) {
    const validated = validatePatch(patch, this.model.settings, { hasAudio: !!this.model.audioPath && fs.existsSync(this.model.audioPath) });
    if (validated.sourceUrl && validated.sourceUrl !== this.model.settings.sourceUrl) await this.sync(validated.sourceUrl);
    // Merge only this action's fields after awaiting: a newer pause/volume action wins.
    const latest = this.model.settings;
    const merged = { ...latest, ...validated, enabledPrayers: { ...latest.enabledPrayers, ...validated.enabledPrayers } };
    if (merged.autoStart !== latest.autoStart) this.desktop.setAutoStart(merged.autoStart);
    this.model.settings = merged; this.model.persist(); this.broadcast(); return this.snapshot();
  }
  async importAudio(forFajr = false) {
    const { canceled, filePaths } = await dialog.showOpenDialog(this.desktop.window, {
      title: forFajr ? 'Choose your full Fajr adhan recording' : 'Choose your full adhan recording', properties: ['openFile'],
      filters: [{ name: 'Audio recordings', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }]
    });
    if (canceled || !filePaths[0]) return this.snapshot();
    const source = filePaths[0], extension = path.extname(source).toLowerCase();
    if (!['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(extension)) throw new Error('Choose an MP3, WAV, Ogg, M4A or FLAC file.');
    const size = fs.statSync(source).size;
    if (size > 250 * 1024 * 1024) throw new Error('Choose a recording smaller than 250 MB.');
    if (size === 0) throw new Error('This audio file is empty. Choose a full adhan recording.');
    await this.player.stop('Stopped to change the recording');
    const destination = path.join(this.app.getPath('userData'), 'recordings', (forFajr ? 'fajr-adhan' : 'adhan') + extension);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
    if (forFajr) { this.model.fajrAudioPath = destination; this.model.settings.fajrAudioName = path.basename(source); }
    else { this.model.audioPath = destination; this.model.settings.audioName = path.basename(source); this.model.settings.playbackMode = 'local'; }
    this.model.log(`${forFajr ? 'Fajr' : 'Local'} recording saved for offline playback.`); this.model.persist(); this.broadcast(); return this.snapshot();
  }
  async useDefaultAudio() {
    if (!fs.existsSync(this.paths.defaultAudioPath)) throw new Error('The included recording is missing. Reinstall Adhan Desk to restore it.');
    await this.player.stop('Stopped to change the recording');
    this.model.audioPath = this.paths.defaultAudioPath; this.model.settings.audioName = 'Default adhan'; this.model.settings.playbackMode = 'local';
    this.model.log('Included adhan recording selected.'); this.model.persist(); this.broadcast(); return this.snapshot();
  }
  async clearFajrAudio() {
    await this.player.stop('Stopped to change the recording');
    this.model.fajrAudioPath = null; this.model.settings.fajrAudioName = null;
    this.model.log('Fajr will use the regular adhan recording.'); this.model.persist(); this.broadcast(); return this.snapshot();
  }
  async play(prayer, eventId = null, isTest = false) {
    const settings = this.model.settings;
    const separateFajr = prayer === 'Fajr' && !!this.model.fajrAudioPath;
    await this.player.start({ prayer, eventId, mode: separateFajr ? 'local' : settings.playbackMode, volume: settings.volume,
      videoId: youtubeId(settings.youtubeUrl), audioName: separateFajr ? settings.fajrAudioName : settings.audioName,
      audioPath: separateFajr ? this.model.fajrAudioPath : this.model.audioPath, isTest, unmuteForAdhan: settings.unmuteForAdhan });
    return this.snapshot();
  }
  async tick() {
    try {
      const now = Date.now();
      if (now >= this.retryAt && !this.syncPromise) { this.retryAt = Infinity; this.sync().catch(() => {}); }
      if (this.model.timetable) {
        const date = dateInZone(now, this.model.timetable.timezone);
        if (date !== this.lastLocalDate) {
          const changed = this.lastLocalDate !== null; this.lastLocalDate = date;
          if (changed && now - this.lastSyncAttempt > 60000) this.sync().catch(() => {});
        }
      }
      if (this.model.settings.enabled) for (const event of dueEvents(this.model.getEvents(), now, Object.keys(this.model.played))) {
        this.model.markAttempt(event, now);
        try { await this.play(event.prayer, event.id); }
        catch (error) { this.model.status.lastError = error.message; this.model.log(error.message, 'error'); this.broadcast(); }
      }
    } catch (error) { this.model.status.lastError = error.message; this.model.log(`Scheduler: ${error.message}`, 'error'); this.broadcast(); }
  }
  registerIPC() {
    const handle = (name, action) => ipcMain.handle('adhan:' + name, (event, ...args) => {
      if (!this.desktop.isMainSender(event)) throw new Error('Untrusted sender');
      return action(...args);
    });
    handle('getState', () => this.snapshot());
    handle('saveSettings', patch => this.saveSettings(patch));
    handle('sync', () => this.sync());
    handle('importAudio', () => this.importAudio());
    handle('importFajrAudio', () => this.importAudio(true));
    handle('clearFajrAudio', () => this.clearFajrAudio());
    handle('useDefaultAudio', () => this.useDefaultAudio());
    handle('testAudio', () => this.play('Test'));
    handle('testFajrAudio', () => this.play('Fajr', null, true));
    handle('stopAudio', async () => { await this.player.stop(); return this.snapshot(); });
    handle('openSource', () => shell.openExternal(validateSource(this.model.settings.sourceUrl)));
    handle('openRecording', () => shell.openExternal(`https://www.youtube.com/watch?v=${youtubeId(this.model.settings.youtubeUrl)}`));
    handle('openAudioCredits', () => shell.openExternal(AUDIO_CREDITS));
    handle('quit', () => this.desktop.quit());
    ipcMain.handle('player:config', event => { if (!this.player?.isSender(event)) throw new Error('Untrusted player'); return this.player.config; });
    ipcMain.handle('player:stop', event => { if (this.player?.isSender(event)) this.player.stop(); });
    ipcMain.on('player:report', (event, data) => { if (this.player?.isSender(event)) this.player.report(data); });
  }
  async dispose() {
    this.desktop.quitting = true;
    this.intervals.forEach(clearInterval);
    await this.player?.stop('Stopped');
    try { this.model.persist(); } catch {}
    this.desktop.dispose();
  }
}
module.exports = { AppController };
