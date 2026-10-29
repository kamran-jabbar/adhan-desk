'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

function resolveHelperPath(file) {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
function validSnapshot(state) {
  if (!state || !Number.isFinite(state.volume) || state.volume < 0 || state.volume > 10 || typeof state.muted !== 'boolean') {
    throw new Error('The system audio backend returned an invalid volume or mute state.');
  }
  return state;
}

// A lease lasts for one playback. Concurrent leases share the original snapshot;
// only the last release restores it. No commands are run until acquire is called.
class SystemAudioService {
  constructor({ platform = process.platform, run = promisify(execFile) } = {}) {
    this.platform = platform; this.run = run; this.pending = Promise.resolve();
    this.leases = new Set(); this.original = null;
  }
  serial(action) {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => {}); return next;
  }
  async command(executable, args) {
    const result = await this.run(executable, args, {
      timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
      ...(this.platform === 'linux' ? { env: { ...process.env, LC_ALL: 'C' } } : {}),
    });
    return String(typeof result === 'string' ? result : result.stdout || '').trim();
  }
  async windows(action, state) {
    const executable = path.win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = resolveHelperPath(path.join(__dirname, 'system-audio', 'WindowsAudio.ps1'));
    const args = ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', action];
    if (state) args.push('-Volume', String(state.volume), '-Muted', String(state.muted), '-DeviceId', state.deviceId);
    const result = JSON.parse(await this.command(executable, args));
    if (!result.deviceId || typeof result.deviceId !== 'string' || result.volume > 1) throw new Error('Windows did not identify a usable output device.');
    return validSnapshot({ ...result, backend: 'windows' });
  }
  async read() {
    if (this.platform === 'win32') return this.windows('Get');
    if (this.platform === 'darwin') {
      const output = await this.command('/usr/bin/osascript', ['-e', 'set v to get volume settings', '-e', 'return (output volume of v as text) & "|" & (output muted of v as text)']);
      const match = /^(\d{1,3})\|(true|false)$/.exec(output);
      if (!match || Number(match[1]) > 100) throw new Error('macOS could not report output volume and mute state.');
      return validSnapshot({ volume: Number(match[1]) / 100, muted: match[2] === 'true', deviceId: null, backend: 'macos' });
    }
    if (this.platform !== 'linux') throw new Error(`Automatic system unmute is not supported on ${this.platform}.`);
    let pulseError;
    try {
      const deviceId = await this.command('pactl', ['get-default-sink']);
      if (!deviceId || /[\r\n]/.test(deviceId) || deviceId.startsWith('-')) throw new Error('No default PulseAudio output was found.');
      const volume = await this.command('pactl', ['get-sink-volume', deviceId]);
      const channels = [...volume.matchAll(/:\s*(\d+)\s*\/\s*[\d.]+%/g)].map(match => Number(match[1]));
      const mute = await this.command('pactl', ['get-sink-mute', deviceId]);
      if (!channels.length || !/^Mute:\s*(yes|no)$/i.test(mute)) throw new Error('PulseAudio returned unreadable output settings.');
      return validSnapshot({ volume: Math.max(...channels) / 65536, muted: /yes$/i.test(mute), deviceId, channels, backend: 'pactl' });
    } catch (error) { pulseError = error; }
    try {
      const details = await this.command('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@']);
      const deviceId = /^\s*id\s+(\d+)[,\s]/m.exec(details)?.[1];
      if (!deviceId) throw new Error('WirePlumber did not identify the default audio output.');
      const output = await this.command('wpctl', ['get-volume', deviceId]);
      const match = /Volume:\s*(\d+(?:\.\d+)?)/.exec(output);
      if (!match) throw new Error('WirePlumber returned an unreadable volume.');
      return validSnapshot({ volume: Number(match[1]), muted: /\[MUTED\]/.test(output), deviceId,
        serial: /object\.serial\s*=\s*"?(\d+)/.exec(details)?.[1] || null, backend: 'wpctl' });
    } catch (error) {
      throw new Error(`Linux system unmute needs a working pactl or wpctl audio backend. pactl: ${pulseError.message}; wpctl: ${error.message}`);
    }
  }
  async write(state) {
    validSnapshot(state);
    if (state.backend === 'windows') { await this.windows('Set', state); return; }
    if (state.backend === 'macos') {
      await this.command('/usr/bin/osascript', ['-e', `set volume output volume ${Math.round(state.volume * 100)} output muted ${state.muted}`]); return;
    }
    if (state.backend === 'pactl') {
      if (state.muted) await this.command('pactl', ['set-sink-mute', state.deviceId, '1']);
      await this.command('pactl', ['set-sink-volume', state.deviceId, ...state.channels.map(String)]);
      await this.command('pactl', ['set-sink-mute', state.deviceId, state.muted ? '1' : '0']); return;
    }
    if (state.backend === 'wpctl') {
      if (state.serial) {
        const details = await this.command('wpctl', ['inspect', state.deviceId]);
        if (/object\.serial\s*=\s*"?(\d+)/.exec(details)?.[1] !== state.serial) throw new Error('The original audio output is no longer available; its settings were not applied to another device.');
      }
      if (state.muted) await this.command('wpctl', ['set-mute', state.deviceId, '1']);
      await this.command('wpctl', ['set-volume', state.deviceId, String(state.volume)]);
      await this.command('wpctl', ['set-mute', state.deviceId, state.muted ? '1' : '0']); return;
    }
    throw new Error('Unsupported system audio backend.');
  }
  acquire() {
    return this.serial(async () => {
      if (!this.original) {
        const original = await this.read();
        const target = { ...original, volume: Math.max(0.35, original.volume), muted: false };
        if (original.channels) target.channels = original.channels.map(value => original.volume ? Math.round(value * target.volume / original.volume) : Math.round(target.volume * 65536));
        try { await this.write(target); }
        catch (error) {
          try { await this.write(original); }
          catch (restoreError) { throw new Error(`System audio override failed (${error.message}); restoring the prior settings also failed (${restoreError.message}).`); }
          throw new Error(`System audio override failed; prior settings restored: ${error.message}`);
        }
        this.original = original;
      }
      const lease = Object.freeze({ id: randomUUID() }); this.leases.add(lease); return lease;
    });
  }
  release(lease) {
    return this.serial(async () => {
      if (!this.leases.delete(lease)) return false;
      if (!this.leases.size) {
        const original = this.original; this.original = null;
        try { await this.write(original); }
        catch (error) { throw new Error(`The prior system audio settings could not be restored: ${error.message}`); }
      }
      return true;
    });
  }
}
module.exports = { SystemAudioService, resolveHelperPath };
