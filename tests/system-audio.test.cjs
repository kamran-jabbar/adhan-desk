'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SystemAudioService, resolveHelperPath } = require('../src/main/services/SystemAudioService.cjs');

function windowsMock(original = { volume: 0.12, muted: true, deviceId: 'speakers-A' }) {
  const calls = []; let state = { ...original };
  const run = async (exe, args, options) => {
    const action = args[args.indexOf('-Action') + 1]; calls.push({ exe, args, options, action });
    if (action === 'Set') state = { volume: Number(args[args.indexOf('-Volume') + 1]), muted: args[args.indexOf('-Muted') + 1] === 'true', deviceId: args[args.indexOf('-DeviceId') + 1] };
    return { stdout: JSON.stringify(state) };
  };
  return { calls, run, state: () => state };
}

test('Windows snapshots, unmutes at a 35% minimum, and restores the same output', async () => {
  const mock = windowsMock();
  const service = new SystemAudioService({ platform: 'win32', run: mock.run });
  assert.equal(mock.calls.length, 0);
  const lease = await service.acquire();
  assert.deepEqual(mock.state(), { volume: 0.35, muted: false, deviceId: 'speakers-A' });
  assert.match(mock.calls[0].exe, /powershell\.exe$/);
  assert.equal(mock.calls[0].options.windowsHide, true);
  assert.equal(mock.calls[0].options.timeout, 15000);
  assert.ok(mock.calls[0].args.includes('-File'));
  assert.equal(mock.calls[0].args.includes('-ExecutionPolicy'), false);
  assert.equal(await service.release(lease), true);
  assert.deepEqual(mock.state(), { volume: 0.12, muted: true, deviceId: 'speakers-A' });
  assert.equal(await service.release(lease), false);
  assert.equal(mock.calls.length, 3);
});

test('existing louder volume is preserved and overlapping leases restore only once', async () => {
  const mock = windowsMock({ volume: 0.8, muted: false, deviceId: 'old-default' });
  const service = new SystemAudioService({ platform: 'win32', run: mock.run });
  const [first, second] = await Promise.all([service.acquire(), service.acquire()]);
  assert.equal(mock.state().volume, 0.8);
  assert.equal(mock.calls.filter(call => call.action === 'Get').length, 1);
  await service.release(first);
  assert.equal(mock.calls.length, 2);
  await service.release(second);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.state().deviceId, 'old-default');
});

test('acquire rolls back partial command failure and does not poison later operations', async () => {
  const mock = windowsMock(); let fail = true;
  const service = new SystemAudioService({ platform: 'win32', run: async (...args) => {
    const result = await mock.run(...args);
    if (fail && args[1].includes('Set')) { fail = false; throw new Error('simulated partial failure'); }
    return result;
  } });
  await assert.rejects(service.acquire(), /prior settings restored/);
  assert.deepEqual(mock.state(), { volume: 0.12, muted: true, deviceId: 'speakers-A' });
  const lease = await service.acquire();
  await service.release(lease);
  assert.equal(mock.state().muted, true);
});

test('release and a following acquire are serialized', async () => {
  const mock = windowsMock();
  const service = new SystemAudioService({ platform: 'win32', run: mock.run });
  const first = await service.acquire();
  const released = service.release(first), next = service.acquire();
  await released;
  const second = await next;
  assert.deepEqual(mock.calls.map(call => call.action), ['Get', 'Set', 'Set', 'Get', 'Set']);
  await service.release(second);
  assert.equal(mock.state().muted, true);
});

test('invalid snapshots fail before any mutation and unsupported platforms are explicit', async () => {
  let calls = 0;
  const invalid = new SystemAudioService({ platform: 'win32', run: async () => {
    calls++; return { stdout: JSON.stringify({ volume: 0.1, muted: 'yes', deviceId: 'speakers' }) };
  } });
  await assert.rejects(invalid.acquire(), /invalid volume or mute state/);
  assert.equal(calls, 1);
  await assert.rejects(new SystemAudioService({ platform: 'freebsd', run: () => assert.fail('No command should run') }).acquire(), /not supported on freebsd/);
});

test('packaged Windows helper resolves outside app.asar', () => {
  assert.equal(resolveHelperPath('C:\\App\\resources\\app.asar\\src\\audio.ps1'), 'C:\\App\\resources\\app.asar.unpacked\\src\\audio.ps1');
  assert.equal(resolveHelperPath('/App/resources/app.asar/src/audio.ps1'), '/App/resources/app.asar.unpacked/src/audio.ps1');
  assert.equal(resolveHelperPath('/App/resources/app.asar.unpacked/audio.ps1'), '/App/resources/app.asar.unpacked/audio.ps1');
});

test('macOS uses built-in osascript and restores integer volume and mute', async () => {
  const calls = [];
  const service = new SystemAudioService({ platform: 'darwin', run: async (exe, args) => {
    calls.push({ exe, args }); return { stdout: calls.length === 1 ? '15|true\n' : '' };
  } });
  const lease = await service.acquire();
  await service.release(lease);
  assert.ok(calls.every(call => call.exe === '/usr/bin/osascript'));
  assert.equal(calls[1].args[1], 'set volume output volume 35 output muted false');
  assert.equal(calls[2].args[1], 'set volume output volume 15 output muted true');
});

test('pactl captures the prior sink and restores each original channel level', async () => {
  const calls = [];
  const service = new SystemAudioService({ platform: 'linux', run: async (exe, args, options) => {
    calls.push({ exe, args, options });
    if (args[0] === 'get-default-sink') return { stdout: 'alsa_output.speakers\n' };
    if (args[0] === 'get-sink-volume') return { stdout: 'Volume: front-left: 3277 / 5% / -78 dB, front-right: 6554 / 10% / -60 dB' };
    if (args[0] === 'get-sink-mute') return { stdout: 'Mute: yes\n' };
    return { stdout: '' };
  } });
  const lease = await service.acquire();
  const target = calls.find(call => call.args[0] === 'set-sink-volume');
  assert.deepEqual(target.args, ['set-sink-volume', 'alsa_output.speakers', '11469', '22938']);
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  await service.release(lease);
  const sets = calls.filter(call => call.args[0] === 'set-sink-volume');
  assert.deepEqual(sets[1].args, ['set-sink-volume', 'alsa_output.speakers', '3277', '6554']);
  assert.equal(calls.filter(call => call.args[0] === 'get-default-sink').length, 1);
  assert.deepEqual(calls.at(-1).args, ['set-sink-mute', 'alsa_output.speakers', '1']);
});

test('WirePlumber is a supported fallback when pactl is unavailable', async () => {
  const calls = [];
  const service = new SystemAudioService({ platform: 'linux', run: async (exe, args) => {
    calls.push({ exe, args });
    if (exe === 'pactl') throw Object.assign(new Error('pactl not found'), { code: 'ENOENT' });
    if (args[0] === 'inspect') return { stdout: 'id 42, type PipeWire:Interface:Node\n    object.serial = "100"' };
    if (args[0] === 'get-volume') return { stdout: 'Volume: 0.12 [MUTED]\n' };
    return { stdout: '' };
  } });
  const lease = await service.acquire();
  assert.ok(calls.some(call => call.args.join(' ') === 'set-volume 42 0.35'));
  await service.release(lease);
  assert.ok(calls.some(call => call.args.join(' ') === 'set-volume 42 0.12'));
  assert.deepEqual(calls.at(-1).args, ['set-mute', '42', '1']);
});

test('missing Linux backends and a replaced WirePlumber device never claim success', async () => {
  const absent = new SystemAudioService({ platform: 'linux', run: async exe => { throw new Error(exe + ' not found'); } });
  await assert.rejects(absent.acquire(), /needs a working pactl or wpctl/);
  let changed = false; const writes = [];
  const service = new SystemAudioService({ platform: 'linux', run: async (exe, args) => {
    if (exe === 'pactl') throw new Error('unavailable');
    if (args[0] === 'inspect') return { stdout: `id 42, type Node\nobject.serial = "${changed ? 101 : 100}"` };
    if (args[0] === 'get-volume') return { stdout: 'Volume: 0.1 [MUTED]' };
    writes.push(args); return { stdout: '' };
  } });
  const lease = await service.acquire(); const before = writes.length; changed = true;
  await assert.rejects(service.release(lease), /original audio output is no longer available/);
  assert.equal(writes.length, before);
});
