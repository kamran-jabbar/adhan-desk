'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(check) {
  for (let count = 0; count < 50; count++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected playback operation was not reached');
}

// Load the production service with mocked dependencies. No Electron windows,
// audio files, native helpers, or operating-system commands are actually used.
function harness({ testMode = false, acquire, release, load } = {}) {
  const events = [], windows = [], errors = [];
  let leaseSequence = 0;
  class MockWindow extends EventEmitter {
    constructor(options) {
      super(); this.id = windows.length + 1; this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setAudioMuted = value => { this.muted = value; events.push(`window:muted:${this.id}`); };
      this.webContents.getURL = () => this.url;
      windows.push(this); events.push(`window:create:${this.id}`);
    }
    async loadURL(url) {
      this.url = url; events.push(`window:load:${this.id}`);
      if (load) await load(this.id);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; }
    destroy() { this.destroyed = true; events.push(`window:destroy:${this.id}`); this.emit('closed'); }
  }
  class MockSystemAudio {
    async acquire() {
      const lease = { id: ++leaseSequence }; events.push(`audio:acquire:start:${lease.id}`);
      if (acquire) await acquire(lease);
      events.push(`audio:acquire:end:${lease.id}`); return lease;
    }
    async release(lease) {
      events.push(`audio:release:start:${lease.id}`);
      if (release) await release(lease);
      events.push(`audio:release:end:${lease.id}`);
    }
  }
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main/services/PlaybackService.cjs');
  const dependencies = {
    electron: { BrowserWindow: MockWindow },
    'node:fs': { existsSync: () => true },
    'node:path': path,
    './DesktopService.cjs': { secureWindow: () => {} },
    './SystemAudioService.cjs': { SystemAudioService: MockSystemAudio },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    },
  }, { filename });
  const service = new module.exports.PlaybackService('http://127.0.0.1/token/', {
    log: () => {}, onChange: () => {},
    onError: message => { errors.push(message); events.push('error:reported'); },
  }, { testMode });
  return { service, events, windows, errors };
}
const playback = {
  prayer: 'Dhuhr', mode: 'local', volume: 89, audioPath: '/mock/adhan.mp3',
  audioName: 'Mock recording', unmuteForAdhan: true,
};

test('production tests and scheduled playback wait for system audio before loading the player', async () => {
  for (const options of [{ prayer: 'Test' }, { prayer: 'Fajr', isTest: true }, { prayer: 'Dhuhr' }]) {
    const gate = deferred();
    const { service, events } = harness({ acquire: () => gate.promise });
    const start = service.start({ ...playback, ...options });
    await waitFor(() => events.includes('audio:acquire:start:1'));
    assert.equal(events.includes('window:load:1'), false);
    gate.resolve(); await start;
    assert.ok(events.indexOf('audio:acquire:end:1') < events.indexOf('window:load:1'));
    assert.equal(service.config.volume, 89, 'The app playback slider remains independent of system volume');
    await service.stop();
  }
});

test('automated test mode mutes the player and skips native audio control', async () => {
  const { service, windows, events, errors } = harness({ testMode: true });
  await service.start({ ...playback, prayer: 'Test' });
  assert.equal(windows[0].muted, true);
  assert.equal(events.some(event => event.startsWith('audio:')), false);
  assert.equal(events.includes('window:load:1'), true);
  await service.stop();
  assert.equal(errors.length, 0);
});

test('audio override failure is reported and normal playback still loads', async () => {
  const { service, events, errors } = harness({ acquire: async () => { throw new Error('native backend unavailable'); } });
  await service.start(playback);
  assert.match(errors[0], /System audio could not be changed: native backend unavailable/);
  assert.ok(events.indexOf('error:reported') < events.indexOf('window:load:1'));
  await service.stop();
  assert.equal(events.some(event => event.startsWith('audio:release:')), false);
});

test('stop and replacement restore prior audio before the next playback starts', async () => {
  for (const explicitlyStop of [false, true]) {
    const gate = deferred();
    const { service, events, windows } = harness({ release: lease => lease.id === 1 ? gate.promise : undefined });
    await service.start(playback);
    let stopping;
    if (explicitlyStop) stopping = service.stop();
    const replacement = service.start({ ...playback, prayer: 'Asr' });
    await waitFor(() => events.includes('audio:release:start:1'));
    assert.equal(windows.length, 1);
    assert.equal(events.includes('audio:acquire:start:2'), false);
    gate.resolve();
    if (stopping) await stopping;
    await replacement;
    assert.ok(events.indexOf('audio:release:end:1') < events.indexOf('window:create:2'));
    assert.ok(events.indexOf('audio:release:end:1') < events.indexOf('audio:acquire:start:2'));
    assert.ok(events.indexOf('audio:acquire:end:2') < events.indexOf('window:load:2'));
    await service.stop();
  }
});

test('completion and playback errors release their lease exactly once', async () => {
  for (const report of [{ type: 'ended' }, { type: 'error', message: 'decoder failed' }]) {
    const { service, events } = harness();
    await service.start(playback);
    service.report(report); await service.queue;
    assert.equal(events.filter(event => event === 'audio:release:end:1').length, 1);
    await service.stop();
    assert.equal(events.filter(event => event === 'audio:release:end:1').length, 1);
  }
});

test('a player load failure restores audio and destroys the failed player', async () => {
  const { service, events, windows } = harness({ load: async () => { throw new Error('player load failed'); } });
  await assert.rejects(service.start(playback), /player load failed/);
  assert.equal(service.state, null);
  assert.equal(windows[0].destroyed, true);
  assert.equal(events.filter(event => event === 'audio:release:end:1').length, 1);
});
