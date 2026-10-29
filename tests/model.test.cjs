'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AppModel } = require('../src/main/models/AppModel.cjs');
const { DEFAULT_SOURCE, RECORDING, createDefaults, validatePatch, validateSource, youtubeId } = require('../src/main/models/SettingsModel.cjs');

function fixture(t, packaged = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhan-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defaultAudioPath = path.join(dir, 'default.mp3');
  fs.writeFileSync(defaultAudioPath, Buffer.from([1, 2, 3]));
  return new AppModel({ userDataPath: path.join(dir, 'profile'), defaultAudioPath, isPackaged: packaged });
}
function timetable() {
  return { sourceUrl: DEFAULT_SOURCE, timezone: 'Europe/Helsinki', fetchedAt: new Date().toISOString(), days: [
    { date: '2026-10-29', prayers: { Fajr: '05:42', Dhuhr: '12:09', Asr: '13:57', Maghrib: '16:34', Isha: '18:35' }, sunrise: '07:44' },
  ] };
}

test('first run selects bundled full recording and packaged login default', t => {
  const model = fixture(t, true).load();
  assert.equal(model.firstRun, true);
  assert.equal(model.settings.enabled, true);
  assert.equal(model.settings.playbackMode, 'local');
  assert.equal(model.settings.audioName, 'Default adhan');
  assert.equal(model.settings.autoStart, true);
  assert.equal(model.audioPath, model.defaultAudioPath);
  assert.equal(model.fajrAudioPath, null);
  assert.equal(model.settings.fajrAudioName, null);
  assert.equal(model.settings.unmuteForAdhan, false);
  assert.equal(createDefaults(false).autoStart, false);
});

test('test mode never starts scheduling or enables login startup', t => {
  const model = fixture(t, true).load({ testMode: true });
  assert.equal(model.settings.enabled, false);
  assert.equal(model.settings.autoStart, false);
});

test('patch validation returns only changed fields and never captures stale settings', () => {
  const current = createDefaults();
  const patch = validatePatch({ volume: 61.4, enabledPrayers: { Fajr: false } }, current, { hasAudio: true });
  assert.deepEqual(patch, { volume: 61, enabledPrayers: { Fajr: false } });
  current.enabled = false;
  assert.equal({ ...current, ...patch }.enabled, false);
  assert.equal(current.enabledPrayers.Fajr, true);
  assert.equal(patch.enabled, undefined);
});

test('strict settings validation rejects unsafe and ambiguous values', () => {
  const current = createDefaults();
  for (const patch of [null, [], { enabled: 1 }, { unmuteForAdhan: 'true' }, { volume: NaN }, { volume: -1 }, { volume: 101 },
    { enabledPrayers: { Sunrise: true } }, { enabledPrayers: { Fajr: 'yes' } }, { enabledPrayers: [] },
    { playbackMode: 'remote' }, { audioPath: 'secret.mp3' }, { audioName: 'override' },
    { fajrAudioPath: 'secret-fajr.mp3' }, { fajrAudioName: 'override' },
    { sourceUrl: 'https://mawaqit.net.attacker.example/en/mosque' }]) {
    assert.throws(() => validatePatch(patch, current, { hasAudio: true }));
  }
  assert.throws(() => validatePatch({ enabled: true }, current, { hasAudio: false }), /Choose a local recording/);
  assert.deepEqual(validatePatch({ enabled: false }, current, { hasAudio: false }), { enabled: false });
});

test('source and YouTube URLs normalize while unsafe origins are rejected', () => {
  assert.equal(validateSource('https://www.mawaqit.net/en/m/hervanta-new-mosque-tampere-33720-finland/?a=1'), DEFAULT_SOURCE);
  for (const link of ['https://youtu.be/5eApyXlK0RA?si=abc', 'https://www.youtube.com/embed/5eApyXlK0RA', 'https://youtube.com/shorts/5eApyXlK0RA']) {
    assert.equal(youtubeId(link), '5eApyXlK0RA');
    assert.equal(validatePatch({ youtubeUrl: link }, createDefaults(), { hasAudio: true }).youtubeUrl, RECORDING);
  }
  for (const link of ['5eApyXlK0RA', 'http://youtu.be/5eApyXlK0RA', 'https://youtube.com.evil.test/watch?v=5eApyXlK0RA',
    'https://user@youtube.com/watch?v=5eApyXlK0RA', 'https://youtube.com/watch?v=short']) assert.throws(() => youtubeId(link));
});

test('atomic state persists attempted prayers before playback and trims old history', t => {
  const model = fixture(t).load();
  model.timetable = timetable();
  model.played.old = Date.now() - 11 * 86400000;
  model.settings.unmuteForAdhan = validatePatch({ unmuteForAdhan: true }, model.settings, { hasAudio: true }).unmuteForAdhan;
  const event = model.getEvents()[0];
  model.markAttempt(event);
  const saved = JSON.parse(fs.readFileSync(model.stateFile, 'utf8'));
  assert.equal(saved.played.old, undefined);
  assert.equal(typeof saved.played[event.id], 'number');
  assert.equal(fs.existsSync(model.stateFile + '.tmp'), false);
  const restored = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(restored.firstRun, false);
  assert.equal(restored.played[event.id], saved.played[event.id]);
  assert.equal(restored.settings.unmuteForAdhan, true);
});

test('a missing imported recording falls back to bundled audio with a visible activity warning', t => {
  const model = fixture(t).load();
  model.audioPath = path.join(model.userDataPath, 'missing.mp3');
  model.settings.audioName = 'My custom recording';
  model.persist();
  const restored = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(restored.audioPath, model.defaultAudioPath);
  assert.equal(restored.settings.audioName, 'Default adhan');
  assert.ok(restored.logs.some(log => /missing.*bundled/i.test(log.message)));
});

test('a separate Fajr recording and its display name persist without replacing the regular recording', t => {
  const model = fixture(t).load();
  const fajr = path.join(path.dirname(model.defaultAudioPath), 'fajr.mp3');
  fs.writeFileSync(fajr, Buffer.from([4, 5, 6]));
  model.fajrAudioPath = fajr;
  model.settings.fajrAudioName = 'My Fajr recording';
  model.persist();
  const saved = JSON.parse(fs.readFileSync(model.stateFile, 'utf8'));
  assert.equal(saved.fajrAudioPath, fajr);
  const restored = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(restored.fajrAudioPath, fajr);
  assert.equal(restored.settings.fajrAudioName, 'My Fajr recording');
  assert.equal(restored.audioPath, model.defaultAudioPath);
  assert.equal(restored.snapshot('win32', '0.1.1').settings.fajrAudioName, 'My Fajr recording');
});

test('an unavailable Fajr override falls back to the unchanged regular recording', t => {
  const model = fixture(t).load();
  const regular = path.join(path.dirname(model.defaultAudioPath), 'regular.mp3');
  fs.writeFileSync(regular, Buffer.from([7, 8, 9]));
  model.audioPath = regular;
  model.settings.audioName = 'Regular recording';
  model.fajrAudioPath = path.join(model.userDataPath, 'missing-fajr.mp3');
  model.settings.fajrAudioName = 'Missing Fajr recording';
  model.persist();
  const restored = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(restored.fajrAudioPath, null);
  assert.equal(restored.settings.fajrAudioName, null);
  assert.equal(restored.audioPath, regular);
  assert.equal(restored.settings.audioName, 'Regular recording');
  assert.ok(restored.logs.some(log => /Fajr recording is missing.*regular adhan/i.test(log.message)));
  restored.persist();
  assert.equal(JSON.parse(fs.readFileSync(restored.stateFile, 'utf8')).fajrAudioPath, null);
});

test('event cache follows timetable replacement and prayer selection', t => {
  const model = fixture(t).load();
  model.timetable = timetable();
  const original = model.getEvents();
  assert.equal(model.getEvents(), original);
  model.settings.volume = 45;
  assert.equal(model.getEvents(), original);
  model.settings.enabledPrayers.Fajr = false;
  assert.equal(model.getEvents().length, 4);
  assert.notEqual(model.getEvents(), original);
  model.timetable = { ...timetable(), days: [] };
  assert.equal(model.getEvents().length, 0);
  assert.equal(model.snapshot('win32', '0.1.0').nextEvent, null);
});

test('corrupt settings pause automation; invalid cached times preserve played history', t => {
  const model = fixture(t).load();
  model.timetable = { ...timetable(), timezone: 'Invalid/Zone' };
  model.played.preserved = Date.now();
  model.persist();
  const restored = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(restored.timetable, null);
  assert.equal(restored.played.preserved, model.played.preserved);
  fs.writeFileSync(model.stateFile, '{ broken');
  const corrupt = new AppModel({ userDataPath: model.userDataPath, defaultAudioPath: model.defaultAudioPath }).load();
  assert.equal(corrupt.firstRun, false);
  assert.equal(corrupt.settings.enabled, false);
  assert.match(corrupt.status.lastError, /paused/);
});
