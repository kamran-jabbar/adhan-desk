'use strict';
const { PRAYERS } = require('../services/scheduler.cjs');
const { normalizeMosqueUrl } = require('../services/mawaqit.cjs');

const DEFAULT_SOURCE = 'https://mawaqit.net/en/hervanta-new-mosque-tampere-33720-finland';
const RECORDING = 'https://www.youtube.com/watch?v=5eApyXlK0RA';
const PATCH_FIELDS = new Set(['sourceUrl', 'enabled', 'enabledPrayers', 'volume', 'playbackMode', 'autoStart', 'preventSleep', 'youtubeUrl']);

function createDefaults(isPackaged = false) {
  return {
    sourceUrl: DEFAULT_SOURCE, enabled: true,
    enabledPrayers: Object.fromEntries(PRAYERS.map(prayer => [prayer, true])),
    volume: 75, playbackMode: 'local', autoStart: !!isPackaged,
    preventSleep: false, audioName: 'Default adhan', youtubeUrl: RECORDING,
  };
}

function validateSource(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a MAWAQIT mosque URL.');
  return normalizeMosqueUrl(value.trim()).replace(/\/m\//, '/');
}

function youtubeId(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a YouTube recording URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid YouTube recording URL.'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(hostname)) {
    throw new Error('Use an HTTPS YouTube recording URL.');
  }
  let id;
  if (hostname.endsWith('youtu.be')) id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else id = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('This URL does not identify a supported YouTube video.');
  return id;
}

function validatePatch(patch, current, { hasAudio = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const result = {};
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`Unsupported setting: ${key}`);
    const value = patch[key];
    if (['enabled', 'autoStart', 'preventSleep'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`Invalid setting: ${key}`);
      result[key] = value;
    } else if (key === 'volume') {
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Volume must be 0–100.');
      result.volume = Math.round(value);
    } else if (key === 'playbackMode') {
      if (!['youtube', 'local'].includes(value)) throw new Error('Invalid audio mode.');
      result.playbackMode = value;
    } else if (key === 'sourceUrl') result.sourceUrl = validateSource(value);
    else if (key === 'youtubeUrl') result.youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId(value)}`;
    else if (key === 'enabledPrayers') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid prayer selection.');
      result.enabledPrayers = {};
      for (const prayer of Object.keys(value)) {
        if (!PRAYERS.includes(prayer) || typeof value[prayer] !== 'boolean') throw new Error('Invalid prayer selection.');
        result.enabledPrayers[prayer] = value[prayer];
      }
    }
  }
  const mode = result.playbackMode ?? current.playbackMode;
  const enabled = result.enabled ?? current.enabled;
  if (mode === 'local' && !hasAudio && (enabled || result.playbackMode === 'local')) {
    throw new Error('Choose a local recording first.');
  }
  return result;
}

module.exports = { DEFAULT_SOURCE, RECORDING, createDefaults, validateSource, youtubeId, validatePatch };
