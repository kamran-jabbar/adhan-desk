/** User interactions and the preload gateway. The view never calls Electron directly. */
export class AppController {
  constructor(api, model, view) {
    this.api = api;
    this.model = model;
    this.view = view;
    this.timers = [];
    this.unsubscribe = null;
  }

  start() {
    this.bindEvents();
    if (!this.api) {
      this.view.showError('Open Adhan Desk using the desktop application to connect to prayer times and audio.');
      this.view.element('retry-button').hidden = true;
      return;
    }
    this.unsubscribe = this.api.onState((snapshot) => this.acceptSnapshot(snapshot));
    this.api.getState().then((snapshot) => this.acceptSnapshot(snapshot)).catch((error) => this.view.showError(error));
    this.timers.push(setInterval(() => this.view.renderClock(), 1000));
    this.timers.push(setInterval(() => { this.view.renderPrayers(); this.view.renderReadiness(); }, 15000));
  }

  acceptSnapshot(snapshot) {
    if (this.model.setSnapshot(snapshot)) this.view.render(this.model);
  }

  async perform(buttonId, action, successMessage) {
    this.view.setBusy(buttonId, true);
    try {
      const result = await action();
      this.acceptSnapshot(result?.settings ? result : await this.api.getState());
      if (successMessage) this.view.showNotice(successMessage);
    } catch (error) {
      // Restore rejected settings so a failed checkbox action cannot look enabled.
      try { this.acceptSnapshot(await this.api.getState()); } catch { /* Preserve the last known snapshot. */ }
      this.view.showError(error);
    } finally {
      this.view.setBusy(buttonId, false);
    }
  }

  showPage(name) {
    this.model.setView(name);
    this.view.showPage(this.model.currentView);
  }

  bindEvents() {
    const on = (id, event, handler) => this.view.element(id).addEventListener(event, handler);
    this.view.all('[data-view]').forEach((button) => button.addEventListener('click', () => this.showPage(button.dataset.view)));
    this.view.all('[data-go-settings]').forEach((button) => button.addEventListener('click', () => this.showPage('settings')));
    on('source-form', 'submit', (event) => {
      event.preventDefault();
      this.perform('save-source', () => this.api.saveSettings({ sourceUrl: this.view.element('source-url').value.trim() }), 'Mosque preference saved.');
    });
    on('youtube-form', 'submit', (event) => {
      event.preventDefault();
      this.perform('save-youtube', () => this.api.saveSettings({ youtubeUrl: this.view.element('youtube-url').value.trim() }), 'YouTube recording saved. Test playback before enabling adhan.');
    });
    on('enabled-toggle', 'change', (event) => this.perform(null, () => this.api.saveSettings({ enabled: event.target.checked })));
    on('autostart', 'change', (event) => this.perform(null, () => this.api.saveSettings({ autoStart: event.target.checked })));
    on('prevent-sleep', 'change', (event) => this.perform(null, () => this.api.saveSettings({ preventSleep: event.target.checked })));
    on('volume', 'input', (event) => this.view.renderVolume(event.target.value));
    on('volume', 'change', (event) => this.perform(null, () => this.api.saveSettings({ volume: Number(event.target.value) })));
    this.view.all('[name=audio-mode]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) this.perform(null, () => this.api.saveSettings({ playbackMode: input.value }));
    }));
    // One delegated listener survives prayer-toggle re-rendering after a state update.
    on('prayer-toggles', 'change', (event) => {
      const prayer = event.target.dataset.prayer;
      if (prayer) this.perform(null, () => this.api.saveSettings(this.model.prayerSettingsPatch(prayer, event.target.checked)));
    });
    // Each entry maps a visible button to a documented preload operation.
    const actions = [
      ['sync-button', 'sync'], ['retry-button', 'sync'],
      ['import-audio', 'importAudio'], ['quick-import-audio', 'importAudio'],
      ['default-audio', 'useDefaultAudio', 'Included adhan recording restored.'],
      ['test-audio', 'testAudio'], ['stop-audio', 'stopAudio'],
      ['source-link', 'openSource'], ['recording-link', 'openRecording'],
      ['audio-credits', 'openAudioCredits'],
    ];
    for (const [id, method, message] of actions) on(id, 'click', () => this.perform(id, () => this.api[method](), message));
    on('quit-button', 'click', () => this.api.quit());
  }

  dispose() {
    this.timers.forEach(clearInterval);
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
    this.view.dispose();
  }
}
