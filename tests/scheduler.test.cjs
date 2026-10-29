'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PRAYERS, dateInZone, zonedTimeToMs, buildEvents, dueEvents, nextEvent } = require('../src/main/services/scheduler.cjs');

const sourceUrl = 'https://mawaqit.net/en/hervanta-new-mosque-tampere-33720-finland';
const timetable = {
  name: 'Tampereen Islamilainen Säätiö', timezone: 'Europe/Helsinki', sourceUrl,
  days: [
    { date: '2026-10-29', sunrise: '07:44', prayers: { Fajr: '05:42', Dhuhr: '12:09', Asr: '13:57', Maghrib: '16:34', Isha: '18:35' } },
    { date: '2026-10-30', sunrise: '07:47', prayers: { Fajr: '05:45', Dhuhr: '12:09', Asr: '13:54', Maghrib: '16:31', Isha: '18:32' } },
  ],
};

test('converts Helsinki winter and summer times independently of the system zone', () => {
  assert.equal(new Date(zonedTimeToMs('2026-10-29', '05:42', 'Europe/Helsinki')).toISOString(), '2026-10-29T03:42:00.000Z');
  assert.equal(new Date(zonedTimeToMs('2026-06-29', '05:42', 'Europe/Helsinki')).toISOString(), '2026-06-29T02:42:00.000Z');
  assert.equal(new Date(zonedTimeToMs('2026-10-29', '05:42', 'Asia/Kathmandu')).toISOString(), '2026-10-28T23:57:00.000Z');
});

test('handles local midnight and year boundaries', () => {
  assert.equal(dateInZone(Date.parse('2026-12-31T22:30:00Z'), 'Europe/Helsinki'), '2027-01-01');
  assert.equal(new Date(zonedTimeToMs('2027-01-01', '00:05', 'Europe/Helsinki')).toISOString(), '2026-12-31T22:05:00.000Z');
});

test('rejects impossible and repeated DST times instead of guessing', () => {
  assert.throws(() => zonedTimeToMs('2026-03-29', '03:30', 'Europe/Helsinki'), { code: 'NONEXISTENT_TIME' });
  assert.throws(() => zonedTimeToMs('2026-10-25', '03:30', 'Europe/Helsinki'), { code: 'AMBIGUOUS_TIME' });
  assert.throws(() => zonedTimeToMs('2026-10-04', '02:15', 'Australia/Lord_Howe'), { code: 'NONEXISTENT_TIME' });
  assert.equal(new Date(zonedTimeToMs('2026-03-29', '04:00', 'Europe/Helsinki')).toISOString(), '2026-03-29T01:00:00.000Z');
});

test('only the five adhan prayers create events; sunrise and iqama never do', () => {
  const withExtra = structuredClone(timetable);
  withExtra.days[0].prayers.Sunrise = '07:44';
  withExtra.days[0].prayers.Iqama = '12:30';
  const events = buildEvents(withExtra);
  assert.equal(events.length, 10);
  assert.deepEqual(events.slice(0, 5).map(event => event.prayer), PRAYERS);
  assert.equal(events[0].atMs, Date.parse('2026-10-29T03:42:00Z'));
});

test('enabled selections support a prayer list or boolean map', () => {
  assert.deepEqual(buildEvents(timetable, ['Fajr']).map(event => event.prayer), ['Fajr', 'Fajr']);
  assert.deepEqual(buildEvents(timetable, { Isha: true, Fajr: false }).map(event => event.prayer), ['Isha', 'Isha']);
  assert.deepEqual(buildEvents(timetable, []), []);
});

test('plays at the scheduled instant, and within the bounded 90 second resume grace', () => {
  const events = buildEvents(timetable);
  const fajr = events[0];
  assert.equal(dueEvents(events, fajr.atMs - 1).length, 0);
  assert.deepEqual(dueEvents(events, fajr.atMs), [fajr]);
  assert.deepEqual(dueEvents(events, fajr.atMs + 90_000), [fajr]);
  assert.equal(dueEvents(events, fajr.atMs + 90_001).length, 0);
});

test('a restart never replays a recorded prayer, including after a timetable correction', () => {
  const events = buildEvents(timetable);
  const fajr = events[0];
  const persistedIds = JSON.parse(JSON.stringify([fajr.id]));
  assert.equal(dueEvents(events, fajr.atMs, persistedIds).length, 0);
  const corrected = structuredClone(timetable);
  corrected.days[0].prayers.Fajr = '05:43';
  const correctedEvents = buildEvents(corrected);
  assert.equal(correctedEvents[0].id, fajr.id);
  assert.equal(dueEvents(correctedEvents, fajr.atMs + 60_000, new Set(persistedIds)).length, 0);
});

test('localized and mobile mosque URLs share one playback identity', () => {
  const original = buildEvents(timetable)[0];
  for (const alternateUrl of [
    'https://mawaqit.net/fi/hervanta-new-mosque-tampere-33720-finland',
    'https://www.mawaqit.net/en/m/hervanta-new-mosque-tampere-33720-finland/',
    'https://mawaqit.net/fr-FR/m/hervanta-new-mosque-tampere-33720-finland',
  ]) {
    const events = buildEvents({ ...timetable, sourceUrl: alternateUrl });
    assert.equal(events[0].id, original.id);
    assert.equal(dueEvents(events, original.atMs + 30_000, [original.id]).length, 0);
  }
  const legacyId = `${sourceUrl}|${original.date}|${original.prayer}`;
  assert.equal(dueEvents(buildEvents(timetable), original.atMs, [legacyId]).length, 0);
  const unrelated = buildEvents({ ...timetable, sourceUrl: 'https://example.com/timetable/one' })[0];
  assert.equal(unrelated.id, `https://example.com/timetable/one|2026-10-29|Fajr`);
  assert.notEqual(unrelated.id, original.id);
});

test('does not flood old prayers after sleep and rolls next prayer to tomorrow', () => {
  const events = buildEvents(timetable);
  const lateEvening = zonedTimeToMs('2026-10-29', '23:50', 'Europe/Helsinki');
  assert.deepEqual(dueEvents(events, lateEvening), []);
  assert.equal(nextEvent(events, lateEvening).date, '2026-10-30');
  assert.equal(nextEvent(events, lateEvening).prayer, 'Fajr');
  assert.equal(nextEvent(events, lateEvening, ['Isha']).prayer, 'Isha');
  assert.equal(nextEvent([], lateEvening), null);
});

test('invalid source times and zones fail closed', () => {
  for (const time of ['24:00', '12:60', '5:42', '', '12:09:00', '12:09 AM']) {
    assert.throws(() => zonedTimeToMs('2026-10-29', time, 'Europe/Helsinki'));
  }
  assert.throws(() => zonedTimeToMs('2026-02-30', '05:42', 'Europe/Helsinki'));
  assert.throws(() => zonedTimeToMs('2026-10-29', '05:42', 'Invalid/Timezone'));
  assert.throws(() => buildEvents({ ...timetable, sourceUrl: '' }));
  assert.throws(() => dueEvents([], NaN));
});

test('DST gaps are omitted, source day duplicates cannot create duplicate triggers', () => {
  const events = buildEvents({ ...timetable, days: [
    { date: '2026-03-29', prayers: { Fajr: '03:30', Dhuhr: '12:00' } },
    { date: '2026-03-29', prayers: { Fajr: '03:30', Dhuhr: '12:00' } },
  ] });
  assert.equal(events.length, 1);
  assert.equal(events[0].prayer, 'Dhuhr');
  assert.equal(dueEvents([events[0], events[0]], events[0].atMs).length, 1);
});
