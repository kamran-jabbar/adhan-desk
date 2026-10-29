'use strict';

// This adapter reads the JSON already published in the public MAWAQIT page.
// It never evaluates page scripts or substitutes calculated prayer times.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_CHARS = 1024 * 1024;
const PRAYER_NAMES = Object.freeze(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
const PRAYER_COLUMNS = Object.freeze([0, 2, 3, 4, 5]);

function normalizeMosqueUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid MAWAQIT mosque URL.'); }
  if (url.protocol !== 'https:' || !['mawaqit.net', 'www.mawaqit.net'].includes(url.hostname) ||
      url.port || url.username || url.password ||
      !/^\/[a-z]{2}(?:-[a-z]{2})?\/(?:m\/)?[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname)) {
    throw new Error('Use an HTTPS MAWAQIT mosque page, such as https://mawaqit.net/en/m/your-mosque.');
  }
  url.hostname = 'mawaqit.net';
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.href;
}

function extractConfData(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) {
    throw new Error('The MAWAQIT page is too large or unreadable.');
  }
  const assignment = /\b(?:let|const|var)\s+confData\s*=\s*/g;
  let match;
  while ((match = assignment.exec(html))) {
    const start = assignment.lastIndex;
    if (html[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length && index - start <= MAX_CONFIG_CHARS; index++) {
      const char = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const conf = JSON.parse(html.slice(start, index + 1));
          if (!conf || typeof conf !== 'object' || Array.isArray(conf)) break;
          return conf;
        } catch { break; }
      }
    }
  }
  throw new Error('MAWAQIT prayer data was not found. The page format may have changed.');
}

function checkedTime(value, context) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`MAWAQIT has an invalid or missing time for ${context}.`);
  }
  return value;
}

function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseTimetable(html, sourceUrl, options = {}) {
  sourceUrl = normalizeMosqueUrl(sourceUrl);
  const conf = extractConfData(html);
  const name = typeof conf.name === 'string' ? conf.name.trim() : '';
  if (!name || name.length > 240) throw new Error('MAWAQIT did not provide a valid mosque name.');
  const timezone = conf.timezone;
  if (typeof timezone !== 'string' || timezone.length > 100) throw new Error('The mosque timezone is missing.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('MAWAQIT provided an unsupported mosque timezone.'); }
  if (!Array.isArray(conf.calendar) || conf.calendar.length !== 12) {
    throw new Error('The mosque has no supported annual MAWAQIT timetable.');
  }
  if (conf.displayingSabahImsak === true) {
    throw new Error('This mosque uses a special Sabah/Imsak timetable that this version cannot safely interpret.');
  }
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) throw new Error('The current date is invalid.');
  const today = localDate(now, timezone);
  const calendarYear = Number(today.slice(0, 4));
  const base = new Date(`${today}T12:00:00.000Z`);
  const days = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(base.getTime() + offset * 86400000);
    // The public calendar does not identify its year. A new-year refresh is required.
    if (date.getUTCFullYear() !== calendarYear) break;
    const dateString = date.toISOString().slice(0, 10);
    const row = conf.calendar[date.getUTCMonth()]?.[String(date.getUTCDate())];
    if (!Array.isArray(row) || row.length !== 6) {
      throw new Error(`The mosque timetable is missing or unsupported for ${dateString}.`);
    }
    const prayers = {};
    PRAYER_NAMES.forEach((prayer, index) => {
      prayers[prayer] = checkedTime(row[PRAYER_COLUMNS[index]], `${prayer} on ${dateString}`);
    });
    days.push({ date: dateString, prayers, sunrise: checkedTime(row[1], `sunrise on ${dateString}`) });
  }
  const finiteCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= limit ? value : null;
  return {
    name,
    timezone,
    location: {
      latitude: finiteCoordinate(conf.latitude, 90),
      longitude: finiteCoordinate(conf.longitude, 180),
      countryCode: typeof conf.countryCode === 'string' && /^[A-Z]{2}$/.test(conf.countryCode) ? conf.countryCode : null
    },
    days,
    fetchedAt: now.toISOString(),
    sourceUrl,
    calendarYear,
    yearIsExplicit: false,
    validThrough: days[days.length - 1].date,
    sourceKind: 'mawaqit-public-calendar',
    // Jumua and iqama are separate mosque events, not replacements for five daily adhan times.
    jumua: typeof conf.jumua === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(conf.jumua) ? conf.jumua : null
  };
}

async function boundedBody(response) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_PAGE_BYTES) throw new Error('The MAWAQIT page is unexpectedly large.');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PAGE_BYTES) {
          await reader.cancel();
          throw new Error('The MAWAQIT page is unexpectedly large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_PAGE_BYTES) throw new Error('The MAWAQIT page is unexpectedly large.');
  return body;
}

async function fetchTimetable(value, fetchImpl = globalThis.fetch, options = {}) {
  let sourceUrl = normalizeMosqueUrl(value);
  if (typeof fetchImpl !== 'function') throw new Error('A network fetch implementation is required.');
  const signal = AbortSignal.timeout(20000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(sourceUrl, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'AdhanDesktop/1.0 (public mosque timetable)' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers?.get?.('location');
      await response.body?.cancel?.();
      if (!target || redirects === 3) throw new Error('MAWAQIT redirected too many times.');
      sourceUrl = normalizeMosqueUrl(new URL(target, sourceUrl).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`Could not refresh the mosque timetable (HTTP ${response.status}).`);
    }
    if (response.url) normalizeMosqueUrl(response.url);
    return parseTimetable(await boundedBody(response), sourceUrl, options);
  }
  throw new Error('Could not load the mosque timetable.');
}

module.exports = { fetchTimetable, parseTimetable, normalizeMosqueUrl, extractConfData, PRAYER_NAMES };
