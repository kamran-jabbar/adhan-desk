import { PRAYERS } from '../models/AppModel.js';

const PRAYER_DETAILS = { Fajr: ['☾', 'Dawn'], Dhuhr: ['☀', 'Midday'], Asr: ['◒', 'Afternoon'], Maghrib: ['◓', 'Sunset'], Isha: ['✧', 'Night'] };

/** DOM rendering only. User actions and IPC calls belong to AppController. */
export class AppView {
  constructor(document) {
    this.document = document;
    this.model = null;
    this.noticeTimer = null;
  }

  element(id) { return this.document.getElementById(id); }
  all(selector) { return this.document.querySelectorAll(selector); }

  create(tag, className, text) {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  showError(error) {
    this.element('error-message').textContent = error?.message || String(error);
    this.element('error-banner').hidden = false;
  }

  showNotice(message) {
    clearTimeout(this.noticeTimer);
    this.element('notice').textContent = message;
    this.element('notice').hidden = false;
    this.noticeTimer = setTimeout(() => { this.element('notice').hidden = true; }, 5500);
  }

  setBusy(buttonId, busy) {
    if (!buttonId) return;
    const button = this.element(buttonId);
    button.disabled = busy;
    if (!busy && this.model?.state) {
      const { settings, status } = this.model.state;
      if (buttonId === 'test-audio') button.disabled = status.playback?.state === 'loading' || (settings.playbackMode === 'local' && !settings.audioName);
      if (buttonId === 'test-fajr-audio') button.disabled = status.playback?.state === 'loading' || !settings.fajrAudioName;
      if (['sync-button', 'save-source'].includes(buttonId)) button.disabled = status.syncing;
    }
  }

  showPage(name) {
    for (const page of ['today', 'settings', 'activity']) this.element(`view-${page}`).hidden = page !== name;
    this.all('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === name);
      if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    this.element('page-title').textContent = name === 'settings' ? 'Make yourself at home.' : name === 'activity' ? 'Everything, in good time.' : 'A moment for what matters.';
  }

  render(model) {
    this.model = model;
    const { state } = model;
    this.element('sidebar-mosque').textContent = state.timetable?.name || 'Your mosque';
    this.element('sidebar-zone').textContent = state.timetable?.timezone || 'Prayer times from MAWAQIT';
    this.element('zone-pill').textContent = state.timetable?.timezone?.split('/').pop()?.replaceAll('_', ' ') || 'Mosque time';
    this.element('zone-pill').title = state.timetable?.timezone || '';
    this.element('error-banner').hidden = !state.status.lastError;
    this.element('error-message').textContent = state.status.lastError || '';
    this.element('sync-button').disabled = state.status.syncing;
    this.element('save-source').disabled = state.status.syncing;
    this.element('sync-button').textContent = state.status.syncing ? 'Refreshing…' : '↻  Refresh times';
    const fetched = state.timetable?.fetchedAt;
    this.element('sync-label').textContent = state.status.syncing ? 'Refreshing mosque timetable…' : fetched ? `MAWAQIT timetable · Synced ${model.displayDate(fetched, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No timetable cached yet';
    this.element('sync-dot').className = `little-dot${state.status.lastError ? ' error' : !fetched ? ' warning' : ''}`;
    this.element('tray-dot').className = `little-dot${state.settings.enabled ? '' : ' warning'}`;
    this.element('tray-label').textContent = state.settings.enabled ? 'Lives in your system tray' : 'Adhan is currently paused';
    this.renderAudio();
    this.renderReadiness();
    this.renderPrayers();
    this.renderSettings();
    this.renderActivity();
    this.renderClock();
  }

  renderPrayers() {
    if (!this.model?.state) return;
    const { state } = this.model;
    const container = this.element('prayer-list');
    container.replaceChildren();
    const today = this.model.dateInZone();
    const day = this.model.todaySchedule();
    const next = this.model.nextEvent();
    for (const prayer of PRAYERS) {
      const event = state.events?.find((item) => item.date === today && item.prayer === prayer);
      const enabled = state.settings.enabledPrayers?.[prayer] !== false;
      const isNext = enabled && next?.date === today && next.prayer === prayer;
      const row = this.create('div', `prayer-row${isNext ? ' next' : ''}${event && event.atMs < this.model.now() ? ' past' : ''}${enabled ? '' : ' disabled'}`);
      const symbol = this.create('span', 'prayer-symbol', PRAYER_DETAILS[prayer][0]);
      symbol.setAttribute('aria-hidden', 'true');
      const name = this.create('span', 'prayer-name', prayer);
      name.append(this.create('small', 'prayer-english', PRAYER_DETAILS[prayer][1]));
      row.append(symbol, name);
      if (isNext) row.append(this.create('span', 'prayer-label', 'UP NEXT'));
      row.append(this.create('span', 'prayer-time', day?.prayers?.[prayer] || '—:—'));
      container.append(row);
    }
    this.element('sunrise-label').textContent = `Sunrise ${day?.sunrise || '—:—'}`;
  }

  renderClock() {
    if (!this.model?.state) return;
    const model = this.model;
    const { state } = model;
    this.element('date-label').textContent = model.displayDate(model.now(), { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
    const next = model.nextEvent();
    const enabled = !!state.settings.enabled;
    const hasEnabledPrayer = model.hasEnabledPrayer();
    this.element('next-eyebrow').textContent = enabled ? 'THE NEXT CALL TO PRAYER' : 'YOUR NEXT PRAYER · ADHAN PAUSED';
    this.element('next-prayer').textContent = next?.prayer || (state.status.syncing ? 'Connecting' : !hasEnabledPrayer ? 'No prayers enabled' : 'Refresh prayer times');
    this.element('next-time').textContent = next?.time || '—:—';
    if (next) {
      this.element('countdown').textContent = model.countdown(next);
      this.element('countdown-caption').textContent = enabled ? 'Until the next prayer' : 'Adhan is paused. Enable it above to play automatically.';
      this.element('next-description').textContent = `${next.date === model.dateInZone() ? 'Today' : model.displayDate(next.atMs, { weekday: 'long' })} · ${state.timetable?.timezone || 'Mosque timezone'} · Mosque prayer time`;
    } else {
      this.element('countdown').textContent = hasEnabledPrayer ? 'Waiting for prayer times' : 'Choose your daily reminders';
      this.element('countdown-caption').textContent = hasEnabledPrayer ? 'Refresh your mosque timetable to continue.' : 'Enable a prayer in Preferences to continue.';
      this.element('next-description').textContent = state.status.syncing ? "Bringing your mosque's timetable to your desktop." : !hasEnabledPrayer ? 'All five prayer reminders are currently switched off.' : 'There are no upcoming enabled prayers in the cached timetable.';
    }
  }

  renderSettings() {
    const { settings } = this.model.state;
    if (this.document.activeElement !== this.element('source-url')) this.element('source-url').value = settings.sourceUrl || '';
    if (this.document.activeElement !== this.element('youtube-url')) this.element('youtube-url').value = settings.youtubeUrl || '';
    this.element('enabled-toggle').checked = !!settings.enabled;
    this.element('scheduler-label').textContent = settings.enabled ? 'Adhan enabled' : 'Adhan paused';
    this.element('autostart').checked = !!settings.autoStart;
    this.element('prevent-sleep').checked = !!settings.preventSleep;
    this.element('unmute-for-adhan').checked = !!settings.unmuteForAdhan;
    this.element('volume').value = settings.volume ?? 75;
    this.renderVolume(settings.volume ?? 75);
    this.element('audio-file-label').textContent = settings.audioName === 'Default adhan' ? 'Included adhan recording · works offline' : settings.audioName || 'Restore the included adhan or choose a personal recording';
    this.element('fajr-audio-label').textContent = settings.fajrAudioName || 'Uses your regular recording';
    this.element('clear-fajr-audio').hidden = !settings.fajrAudioName;
    this.element('fajr-audio-guidance').textContent = settings.fajrAudioName
      ? 'Fajr will use this recording. Test it to check the dawn-specific “Prayer is better than sleep” lines.'
      : 'Fajr uses your regular adhan unless you choose a separate recording with the extra Fajr lines.';
    this.element('audio-volume-note').textContent = settings.unmuteForAdhan
      ? 'The full recording plays once per enabled prayer. System output is temporarily unmuted at a minimum 35% volume, then restored after playback.'
      : 'The full recording plays once at each enabled prayer. System volume and mute still apply.';
    this.element('youtube-warning').hidden = !settings.youtubeUrl?.includes('5eApyXlK0RA');
    this.all('[name=audio-mode]').forEach((input) => { input.checked = input.value === settings.playbackMode; });
    const container = this.element('prayer-toggles');
    container.replaceChildren();
    for (const prayer of PRAYERS) {
      const label = this.create('label', 'setting-toggle');
      const copy = this.create('span');
      copy.append(this.create('strong', '', prayer));
      const input = this.create('input', 'switch-input');
      input.type = 'checkbox';
      input.dataset.prayer = prayer;
      input.checked = settings.enabledPrayers?.[prayer] !== false;
      input.setAttribute('aria-label', `Play adhan for ${prayer}`);
      const track = this.create('span', 'switch-track');
      track.setAttribute('aria-hidden', 'true');
      label.append(copy, input, track);
      container.append(label);
    }
  }

  renderVolume(value) { this.element('volume-label').textContent = `${value}%`; }

  renderAudio() {
    const { settings, status } = this.model.state;
    const local = settings.playbackMode === 'local';
    this.element('audio-description').textContent = local ? (settings.audioName ? `${settings.audioName === 'Default adhan' ? 'Included adhan recording' : settings.audioName} · plays in full, even without internet.` : 'Restore the included adhan in Audio preferences, or choose a full adhan audio file.') : settings.youtubeUrl?.includes('5eApyXlK0RA') ? 'This YouTube recording blocks embedded playback. Use the included adhan or another video in Audio preferences.' : 'Online playback requires internet and a video that allows embedding. Test your recording before enabling adhan.';
    const playing = status.playback?.state === 'playing';
    const preparing = status.playback?.state === 'loading';
    this.element('test-audio').disabled = preparing || (local && !settings.audioName);
    this.element('test-audio').hidden = local && !settings.audioName;
    this.element('quick-import-audio').hidden = !local || !!settings.audioName;
    this.element('stop-audio').hidden = !(playing || preparing);
    this.element('test-audio').textContent = preparing ? 'Preparing audio…' : playing ? '▷  Play again' : '▷  Test adhan';
    this.element('test-fajr-audio').disabled = preparing || !settings.fajrAudioName;
    this.element('fajr-summary').hidden = !settings.fajrAudioName;
    this.element('fajr-summary').textContent = settings.fajrAudioName ? `Fajr has its own recording: ${settings.fajrAudioName}` : '';
  }

  renderReadiness() {
    if (!this.model?.state) return;
    const { settings, status } = this.model.state;
    const local = settings.playbackMode === 'local';
    const playback = status.playback;
    let title = 'Ready on your desktop';
    let description = settings.unmuteForAdhan
      ? 'Close this window to keep adhan running in the background. Keep your computer awake and physical speakers on; system output will be unmuted for playback.'
      : 'Close this window to keep adhan running in the background. Keep your computer awake and speakers unmuted.';
    if (playback?.state === 'error') {
      title = 'Audio needs attention';
      description = playback.error || playback.message || 'The recording could not play. Try Test adhan, or choose a local recording in Preferences.';
    } else if (playback?.state === 'loading') {
      title = 'Preparing your adhan';
      description = local ? 'Opening the selected audio file. Playback starts when it is ready.' : 'Connecting to your YouTube recording. An internet connection is required.';
    } else if (playback?.state === 'playing') {
      title = 'Adhan is playing';
      description = 'The recording plays to the end. Use Stop whenever you need to.';
    } else if (local && !settings.audioName) {
      title = 'Choose your recording';
      description = 'Restore the included recording in Audio preferences, or choose a personal audio file. Offline playback needs an available recording.';
    } else if (!settings.enabled) {
      title = 'Adhan is paused';
      description = 'Test your recording, then enable adhan above to start automatic prayer audio.';
    } else if (!this.model.nextEvent()) {
      title = this.model.hasEnabledPrayer() ? 'Prayer times need a refresh' : 'No prayer reminders enabled';
      description = this.model.hasEnabledPrayer() ? 'Refresh the mosque timetable below. Automatic adhan needs upcoming prayer times.' : 'Choose the prayers you want to hear in Preferences.';
    } else if (settings.preventSleep) {
      title = 'Keeping your computer awake';
      description = settings.unmuteForAdhan
        ? 'Idle sleep prevention is enabled. System output will be unmuted for playback; physical speakers must be on.'
        : 'Idle sleep prevention is enabled. Keep your speakers connected and unmuted.';
    }
    this.element('readiness-title').textContent = title;
    this.element('readiness-description').textContent = description;
  }

  renderActivity() {
    const container = this.element('activity-list');
    container.replaceChildren();
    const logs = this.model.state.status.logs || [];
    if (!logs.length) {
      container.append(this.create('p', 'activity-empty', 'Your activity will appear here after a timetable refresh or adhan playback.'));
      return;
    }
    for (const log of [...logs].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 60)) {
      const row = this.create('div', `activity-row${log.level === 'error' ? ' error' : ''}`);
      const timestamp = new Date(log.at);
      const time = this.create('time', '', Number.isNaN(timestamp.valueOf()) ? '' : this.model.displayDate(timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
      if (!Number.isNaN(timestamp.valueOf())) time.dateTime = timestamp.toISOString();
      row.append(time, this.create('span', '', log.message));
      container.append(row);
    }
  }

  dispose() { clearTimeout(this.noticeTimer); }
}
