'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildEvents, nextEvent } = require('../services/scheduler.cjs');
const { createDefaults, validatePatch } = require('./SettingsModel.cjs');

const HISTORY_MS = 10 * 86400000;
const SAVED_FIELDS = ['sourceUrl', 'enabled', 'enabledPrayers', 'volume', 'playbackMode', 'autoStart', 'preventSleep', 'youtubeUrl'];
function audioExists(file) {
  try { return typeof file === 'string' && fs.statSync(file).isFile() && fs.statSync(file).size > 0; }
  catch { return false; }
}

class AppModel {
  constructor({ userDataPath, defaultAudioPath, isPackaged = false }) {
    this.userDataPath = userDataPath; this.defaultAudioPath = defaultAudioPath; this.isPackaged = isPackaged;
    this.settings = createDefaults(isPackaged); this.timetable = null; this.played = {}; this.logs = [];
    this.audioPath = audioExists(defaultAudioPath) ? defaultAudioPath : null;
    this.firstRun = true; this.status = { syncing: false, lastError: null, playback: null, logs: this.logs };
    this.cachedTimetable = null; this.cachedKey = ''; this.cachedEvents = [];
  }
  get stateFile() { return path.join(this.userDataPath, 'state.json'); }
  log(message, level = 'info') {
    this.logs.unshift({ at: new Date().toISOString(), message: String(message).slice(0, 2000), level });
    this.logs.length = Math.min(this.logs.length, 80); this.status.logs = this.logs;
  }
  load({ testMode = false } = {}) {
    this.firstRun = !fs.existsSync(this.stateFile);
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid saved state.');
      this.played = data.played && typeof data.played === 'object' && !Array.isArray(data.played) ? data.played : {};
      this.logs = Array.isArray(data.logs) ? data.logs.filter(item => item && typeof item.message === 'string' && Number.isFinite(Date.parse(item.at))).slice(0, 80) : [];
      this.status.logs = this.logs;
      if (audioExists(data.audioPath)) this.audioPath = data.audioPath;
      else if (data.audioPath && data.audioPath !== this.defaultAudioPath) this.log('The saved recording is missing. Using the bundled default adhan.', 'warning');
      const saved = data.settings && typeof data.settings === 'object' ? data.settings : {};
      const patch = Object.fromEntries(SAVED_FIELDS.filter(key => key in saved).map(key => [key, saved[key]]));
      const validated = validatePatch(patch, this.settings, { hasAudio: !!this.audioPath });
      this.settings = { ...this.settings, ...validated, enabledPrayers: { ...this.settings.enabledPrayers, ...validated.enabledPrayers } };
      if (this.audioPath && this.audioPath !== this.defaultAudioPath) {
        this.settings.audioName = typeof saved.audioName === 'string' && saved.audioName.length <= 240 ? saved.audioName : path.basename(this.audioPath);
      }
      if (data.timetable) {
        try { buildEvents(data.timetable, this.settings.enabledPrayers); this.timetable = data.timetable; }
        catch { this.log('The cached timetable is invalid. Refresh mosque times to continue.', 'warning'); }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.settings = createDefaults(this.isPackaged); this.settings.enabled = false;
        this.status.lastError = 'Saved settings could not be read; automation is paused. Please check your setup.';
        this.log(this.status.lastError, 'error');
      }
    }
    if (!this.audioPath && this.settings.playbackMode === 'local') {
      this.settings.enabled = false; this.settings.audioName = null;
      this.status.lastError = 'The default recording is unavailable. Choose a local recording to enable adhan.';
      this.log(this.status.lastError, 'error');
    }
    if (testMode) { this.settings.enabled = false; this.settings.autoStart = false; }
    return this;
  }
  persist() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const cutoff = Date.now() - HISTORY_MS;
    this.played = Object.fromEntries(Object.entries(this.played).filter(([, value]) => Number.isFinite(value) && value >= cutoff));
    const temporary = this.stateFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, settings: this.settings, timetable: this.timetable,
      played: this.played, audioPath: this.audioPath, logs: this.logs }, null, 2), 'utf8');
    fs.renameSync(temporary, this.stateFile);
  }
  getEvents() {
    if (!this.timetable || this.timetable.sourceUrl !== this.settings.sourceUrl) return [];
    const key = `${this.timetable.fetchedAt}|${JSON.stringify(this.settings.enabledPrayers)}`;
    if (this.cachedTimetable !== this.timetable || this.cachedKey !== key) {
      try { this.cachedEvents = buildEvents(this.timetable, this.settings.enabledPrayers); }
      catch { return []; }
      this.cachedTimetable = this.timetable; this.cachedKey = key;
    }
    return this.cachedEvents;
  }
  snapshot(platform, version) {
    const events = this.getEvents();
    return { settings: { ...this.settings, enabledPrayers: { ...this.settings.enabledPrayers } }, timetable: this.timetable,
      events, nextEvent: nextEvent(events, Date.now()), status: { ...this.status, logs: this.logs.slice() }, platform, version };
  }
  markAttempt(event, now = Date.now()) {
    if (!event || typeof event.id !== 'string' || !Number.isFinite(now)) throw new Error('Invalid scheduled playback attempt.');
    this.played[event.id] = now; this.persist();
  }
}

module.exports = { AppModel };
