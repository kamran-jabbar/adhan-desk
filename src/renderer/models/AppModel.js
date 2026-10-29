export const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** Renderer state and prayer/date queries. No DOM or Electron dependency. */
export class AppModel {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.state = null;
    this.currentView = 'today';
  }

  setSnapshot(value) {
    if (!value?.settings) return false;
    this.state = { ...value, status: { syncing: false, lastError: null, logs: [], ...value.status } };
    return true;
  }

  setView(name) {
    if (['today', 'settings', 'activity'].includes(name)) this.currentView = name;
  }

  now() { return this.clock(); }

  timezone() {
    return this.state?.timetable?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  dateInZone(timestamp = this.now(), timezone = this.timezone()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  displayDate(timestamp, options = {}) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.timezone(), ...options }).format(new Date(timestamp));
  }

  nextEvent() {
    const now = this.now();
    return this.state?.events?.filter((item) => item.atMs > now && this.state.settings.enabledPrayers?.[item.prayer] !== false).sort((a, b) => a.atMs - b.atMs)[0] || null;
  }

  todaySchedule() {
    return this.state?.timetable?.days?.find((item) => item.date === this.dateInZone()) || null;
  }

  hasEnabledPrayer() {
    return PRAYERS.some((prayer) => this.state?.settings.enabledPrayers?.[prayer] !== false);
  }

  countdown(event) {
    const seconds = Math.max(0, Math.floor((event.atMs - this.now()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  prayerSettingsPatch(prayer, enabled) {
    return { enabledPrayers: { ...this.state.settings.enabledPrayers, [prayer]: enabled } };
  }
}
