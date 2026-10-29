'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { startServer } = require('../src/main/services/server.cjs');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

test('loopback server restricts access and streams seekable recordings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhan-server-test-'));
  for (const name of ['index.html', 'styles.css', 'renderer.js', 'player.html', 'player.css', 'player.js']) {
    fs.writeFileSync(path.join(dir, name), name.endsWith('.html') ? '<!doctype html><p>Test</p>' : 'test');
  }
  const audio = path.join(dir, 'recording.mp3');
  fs.writeFileSync(audio, Buffer.from('0123456789'));
  const { server, base } = await startServer(dir, () => audio);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('rejects wrong hosts and all HTTP mutations', async () => {
    assert.equal((await request(base + 'index.html', { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await request(base + 'index.html', { method: 'POST' })).status, 403);
    assert.equal((await request(base + 'index.html', { method: 'PUT' })).status, 403);
  });

  await t.test('requires the secret path and only serves explicit assets', async () => {
    assert.equal((await request(new URL('/index.html', base))).status, 404);
    assert.equal((await request(base + 'state.json')).status, 404);
    assert.equal((await request(base + '%2e%2e%2fstate.json')).status, 404);
    assert.equal((await request(base + 'index.html')).status, 200);
  });

  await t.test('main UI and player use separate restrictive content policies', async () => {
    const main = await request(base + 'index.html');
    const player = await request(base + 'player.html');
    assert.match(main.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(main.headers['content-security-policy'], /script-src 'self';/);
    assert.doesNotMatch(main.headers['content-security-policy'], /unsafe-inline|unsafe-eval|youtube/);
    assert.match(player.headers['content-security-policy'], /frame-src https:\/\/www.youtube.com/);
    assert.equal(main.headers['x-content-type-options'], 'nosniff');
    assert.equal(player.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(main.headers['access-control-allow-origin'], undefined);
  });

  await t.test('full and HEAD recordings provide lengths without truncation', async () => {
    const full = await request(base + 'audio');
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), '0123456789');
    assert.equal(full.headers['content-type'], 'audio/mpeg');
    assert.equal(full.headers['content-length'], '10');
    const head = await request(base + 'audio', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.body.length, 0);
  });

  await t.test('byte ranges support audio seeking and reject invalid requests', async () => {
    const range = await request(base + 'audio', { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString(), '2345');
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    assert.equal(range.headers['content-length'], '4');
    assert.equal((await request(base + 'audio', { headers: { Range: 'bytes=7-' } })).body.toString(), '789');
    assert.equal((await request(base + 'audio', { headers: { Range: 'bytes=99-100' } })).status, 416);
    assert.equal((await request(base + 'audio', { headers: { Range: 'bytes=5-2' } })).status, 416);
    assert.equal((await request(base + 'audio', { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
  });
});

// Isolate malformed/empty-file regressions: an uncaught HTTP handler exception
// must be reported as a failed assertion rather than terminate the test runner.
function isolatedRequest(dir, mode) {
  const script = `
    const {startServer} = require(process.argv[1]);
    const http = require('node:http');
    const net = require('node:net');
    let server;
    function finish(result) {
      process.stdout.write(JSON.stringify(result));
      server?.closeAllConnections();
      server?.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 20);
    }
    process.on('uncaughtException', error => finish({error: error.code || error.message}));
    (async () => {
      const result = await startServer(process.argv[2], () => require('node:path').join(process.argv[2], 'empty.mp3'));
      server = result.server;
      if (process.argv[3] === 'empty') {
        http.get(result.base + 'audio', response => {
          let bytes = 0; response.on('data', chunk => bytes += chunk.length);
          response.on('end', () => finish({status: response.statusCode, bytes}));
        }).on('error', error => finish({error: error.code || error.message}));
      } else {
        const socket = net.connect(server.address().port, '127.0.0.1', () => {
          socket.write('GET http://[ HTTP/1.1\\r\\nHost: 127.0.0.1:' + server.address().port + '\\r\\nConnection: close\\r\\n\\r\\n');
        });
        let response = ''; socket.on('data', chunk => response += chunk);
        socket.on('end', () => finish({status: Number(response.split(' ')[1])}));
        socket.on('error', error => finish({error: error.code || error.message}));
      }
      setTimeout(() => finish({error: 'timeout'}), 2000);
    })().catch(error => finish({error: error.message}));
  `;
  const child = spawnSync(process.execPath, ['--eval', script, path.resolve(__dirname, '../src/main/services/server.cjs'), dir, mode], { encoding: 'utf8', timeout: 4000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('empty recordings and malformed request URLs cannot crash the server', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhan-edge-test-'));
  fs.writeFileSync(path.join(dir, 'empty.mp3'), '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const empty = isolatedRequest(dir, 'empty');
  assert.equal(empty.error, undefined, 'An empty recording must not throw from the request handler');
  assert.ok([200, 404, 416].includes(empty.status));
  assert.equal(empty.bytes, 0);
  const malformed = isolatedRequest(dir, 'malformed');
  assert.equal(malformed.error, undefined, 'Malformed request targets must not throw from the request handler');
  assert.ok([400, 403, 404].includes(malformed.status));
});
