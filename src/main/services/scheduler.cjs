'use strict';

// All wall-clock times belong to the mosque's IANA time zone, never the PC's.
const PRAYERS = Object.freeze(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
const formatterCache = new Map();

function formatter(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    throw new TypeError('A mosque IANA time zone is required.');
  }
  if (!formatterCache.has(timezone)) {
    formatterCache.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatterCache.get(timezone);
}

function partsAt(nowMs, timezone) {
  if (!Number.isFinite(nowMs)) throw new TypeError('Time must be a finite Unix timestamp in milliseconds.');
  const parts = {};
  for (const part of formatter(timezone).formatToParts(new Date(nowMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

function dateInZone(nowMs, timezone) {
  const parts = partsAt(nowMs, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseWallTime(date, time) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError('Prayer date must be YYYY-MM-DD.');
  }
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new TypeError('Prayer time must be HH:mm between 00:00 and 23:59.');
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (year < 1000) throw new RangeError('Prayer date year must be at least 1000.');
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wallMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError('Prayer date does not exist.');
  }
  return { wallMs, date, time };
}

function zonedTimeToMs(date, time, timezone) {
  const { wallMs } = parseWallTime(date, time);
  formatter(timezone); // Validate before searching, including an unsupported zone.
  const offsets = new Set();
  // Observe both sides of nearby clock changes, including 30-minute changes and
  // historical date-line changes. Candidate instants are verified below.
  for (let hours = -72; hours <= 72; hours += 6) {
    const sampleMs = wallMs + hours * 60 * 60 * 1000;
    const parts = partsAt(sampleMs, timezone);
    const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    offsets.add(localMs - sampleMs);
  }
  const candidates = [];
  for (const offset of offsets) {
    const atMs = wallMs - offset;
    const parts = partsAt(atMs, timezone);
    if (`${parts.year}-${parts.month}-${parts.day}` === date && `${parts.hour}:${parts.minute}` === time && parts.second === '00') {
      candidates.push(atMs);
    }
  }
  if (candidates.length !== 1) {
    const error = new RangeError(candidates.length ? 'Prayer time is ambiguous during a clock change.' : 'Prayer time does not exist during a clock change.');
    error.code = candidates.length ? 'AMBIGUOUS_TIME' : 'NONEXISTENT_TIME';
    throw error;
  }
  return candidates[0];
}

function enabledSet(enabledPrayers = PRAYERS) {
  if (Array.isArray(enabledPrayers) || enabledPrayers instanceof Set) {
    return new Set([...enabledPrayers].filter(prayer => PRAYERS.includes(prayer)));
  }
  if (enabledPrayers && typeof enabledPrayers === 'object') {
    return new Set(PRAYERS.filter(prayer => enabledPrayers[prayer] === true));
  }
  throw new TypeError('Enabled prayers must be an array, Set, or boolean map.');
}

function sourceIdentity(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const match = /^\/[a-z]{2}(?:-[a-z]{2})?\/(?:m\/)?([a-z0-9][a-z0-9-]*)\/?$/i.exec(url.pathname);
    if (hostname === 'mawaqit.net' && match) return `${hostname}/${match[1].toLowerCase()}`;
  } catch {}
  return sourceUrl;
}

function canonicalEventId(id) {
  if (typeof id !== 'string') return id;
  const prayerSeparator = id.lastIndexOf('|');
  const dateSeparator = id.lastIndexOf('|', prayerSeparator - 1);
  if (dateSeparator < 0) return id;
  const date = id.slice(dateSeparator + 1, prayerSeparator);
  const prayer = id.slice(prayerSeparator + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !PRAYERS.includes(prayer)) return id;
  return `${sourceIdentity(id.slice(0, dateSeparator))}|${date}|${prayer}`;
}

function buildEvents(timetable, enabledPrayers = PRAYERS) {
  if (!timetable || !Array.isArray(timetable.days)) throw new TypeError('A dated mosque timetable is required.');
  formatter(timetable.timezone);
  if (typeof timetable.sourceUrl !== 'string' || !timetable.sourceUrl) throw new TypeError('The timetable source URL is required.');
  const enabled = enabledSet(enabledPrayers);
  const events = [];
  const seen = new Set();
  for (const day of timetable.days) {
    for (const prayer of PRAYERS) {
      if (!enabled.has(prayer)) continue;
      const time = day.prayers?.[prayer];
      if (time === undefined || time === null) continue;
      let atMs;
      try {
        atMs = zonedTimeToMs(day.date, time, timetable.timezone);
      } catch (error) {
        // A local clock change must never silently select the wrong instant.
        if (error.code === 'AMBIGUOUS_TIME' || error.code === 'NONEXISTENT_TIME') continue;
        throw error;
      }
      const id = `${sourceIdentity(timetable.sourceUrl)}|${day.date}|${prayer}`;
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({ id, prayer, date: day.date, time, atMs });
    }
  }
  return events.sort((a, b) => a.atMs - b.atMs || PRAYERS.indexOf(a.prayer) - PRAYERS.indexOf(b.prayer));
}

function dueEvents(events, nowMs, playedIds = [], graceMs = 90_000) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('The current time and grace period must be valid milliseconds.');
  // Accept IDs from earlier versions that included the entire localized URL.
  const played = new Set([...playedIds].map(canonicalEventId));
  const emitted = new Set();
  return events.filter(event => {
    if (!PRAYERS.includes(event.prayer) || !Number.isFinite(event.atMs)) return false;
    const age = nowMs - event.atMs;
    const id = canonicalEventId(event.id);
    if (age < 0 || age > graceMs || played.has(id) || emitted.has(id)) return false;
    emitted.add(id);
    return true;
  }).sort((a, b) => a.atMs - b.atMs);
}

function nextEvent(events, nowMs, enabledPrayers = PRAYERS) {
  if (!Number.isFinite(nowMs)) throw new TypeError('The current time must be a finite timestamp.');
  const enabled = enabledSet(enabledPrayers);
  return events.filter(event => enabled.has(event.prayer) && Number.isFinite(event.atMs) && event.atMs >= nowMs)
    .sort((a, b) => a.atMs - b.atMs)[0] || null;
}

module.exports = { PRAYERS, dateInZone, zonedTimeToMs, buildEvents, dueEvents, nextEvent };
