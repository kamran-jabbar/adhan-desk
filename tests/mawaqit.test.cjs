'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchTimetable, parseTimetable, normalizeMosqueUrl, extractConfData } = require('../src/main/services/mawaqit.cjs');

const URL = 'https://mawaqit.net/en/m/hervanta-new-mosque-tampere-33720-finland';
// Shape and Oct 29 values taken from this mosque's public confData on 2026-10-29.
function fixture(overrides = {}) {
  const row = ['05:42', '07:44', '12:09', '13:57', '16:34', '18:35'];
  const conf = {
    name: 'Tampereen Islamilainen Säätiö', timezone: 'Europe/Helsinki',
    latitude: 61.452593376002, longitude: 23.845149278641, countryCode: 'FI',
    calendar: Array.from({ length: 12 }, () => Object.fromEntries(Array.from({ length: 31 }, (_, i) => [i + 1, [...row]]))),
    times: ['05:42', '12:09', '13:57', '16:34', '18:35'], shuruq: '07:44', jumua: '12:09',
    ...overrides
  };
  return `<html><script>let confData = ${JSON.stringify(conf)}; let lang = 'en';</script></html>`;
}

test('reads mosque data and excludes sunrise from the five daily adhans', () => {
  const result = parseTimetable(fixture(), URL, { now: '2026-10-29T09:30:00Z' });
  assert.equal(result.name, 'Tampereen Islamilainen Säätiö');
  assert.equal(result.timezone, 'Europe/Helsinki');
  assert.equal(result.days.length, 7);
  assert.deepEqual(result.days[0], {
    date: '2026-10-29', sunrise: '07:44',
    prayers: { Fajr: '05:42', Dhuhr: '12:09', Asr: '13:57', Maghrib: '16:34', Isha: '18:35' }
  });
  assert.equal(result.days.at(-1).date, '2026-11-04');
  assert.equal(result.fetchedAt, '2026-10-29T09:30:00.000Z');
  assert.equal(result.yearIsExplicit, false);
});

test('uses the mosque local date rather than the operating system date', () => {
  const result = parseTimetable(fixture(), URL, { now: '2026-10-28T22:30:00Z' });
  assert.equal(result.days[0].date, '2026-10-29');
});

test('does not assume the unlabelled annual timetable applies to the next year', () => {
  const result = parseTimetable(fixture(), URL, { now: '2026-12-30T09:00:00Z' });
  assert.deepEqual(result.days.map(day => day.date), ['2026-12-30', '2026-12-31']);
  assert.equal(result.validThrough, '2026-12-31');
});

test('handles braces and escaped quotes in strings without evaluating scripts', () => {
  const html = fixture({ name: 'A } { "quoted" mosque', announcements: [{ text: 'literal }; content' }] });
  assert.equal(extractConfData(html).name, 'A } { "quoted" mosque');
  assert.throws(() => extractConfData('<script>let confData = {name: process.exit()};</script>'), /not found/);
  assert.throws(() => extractConfData('x'.repeat(2 * 1024 * 1024 + 1)), /too large/);
});

test('rejects missing, ambiguous or invalid source data', () => {
  assert.throws(() => parseTimetable(fixture({ timezone: 'MadeUp/Zone' }), URL), /timezone/);
  assert.throws(() => parseTimetable(fixture({ calendar: [] }), URL), /timetable/);
  assert.throws(() => parseTimetable(fixture({ displayingSabahImsak: true }), URL), /Sabah/);
  const conf = extractConfData(fixture());
  conf.calendar[9]['29'][0] = '25:10';
  assert.throws(() => parseTimetable(`let confData = ${JSON.stringify(conf)};`, URL, { now: '2026-10-29' }), /Fajr/);
});

test('allows only public HTTPS MAWAQIT mosque pages', () => {
  assert.equal(normalizeMosqueUrl(`${URL}/?a=1#x`), URL);
  for (const url of ['http://mawaqit.net/en/x', 'https://evil.test/en/x', 'https://mawaqit.net.evil.test/en/x',
    'https://user:pass@mawaqit.net/en/x', 'https://mawaqit.net:8443/en/x', 'https://mawaqit.net/api/x']) {
    assert.throws(() => normalizeMosqueUrl(url), /MAWAQIT/);
  }
});

test('fetch follows canonical redirects, validates the destination, and parses data', async () => {
  const calls = [];
  const result = await fetchTimetable(URL, async (url, options) => {
    calls.push([url, options.redirect]);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/en/hervanta-new-mosque-tampere-33720-finland' } })
      : new Response(fixture(), { status: 200 });
  }, { now: '2026-10-29' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], 'manual');
  assert.equal(result.sourceUrl, 'https://mawaqit.net/en/hervanta-new-mosque-tampere-33720-finland');
  await assert.rejects(fetchTimetable(URL, async () => new Response(null, {
    status: 302, headers: { location: 'https://evil.test/private' }
  })), /MAWAQIT/);
});

test('network errors and oversized responses cannot become invented prayer times', async () => {
  await assert.rejects(fetchTimetable(URL, async () => new Response('Unavailable', { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchTimetable(URL, async () => new Response('x', {
    headers: { 'content-length': String(3 * 1024 * 1024) }
  })), /large/);
  await assert.rejects(fetchTimetable(URL, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /large/);
});
