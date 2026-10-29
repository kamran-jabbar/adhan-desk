const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// Loopback gives YouTube a real HTTP origin/referrer. There are no HTTP control
// endpoints: desktop controls use a separate, sender-checked IPC bridge.
async function startServer(rendererDir, getAudioPath) {
  const token = randomBytes(24).toString('hex');
  const allowed = new Map([
    ['index.html', 'text/html'], ['styles.css', 'text/css'], ['renderer.js', 'text/javascript'],
    ['player.html', 'text/html'], ['player.css', 'text/css'], ['player.js', 'text/javascript'],
    ['models/AppModel.js', 'text/javascript'], ['views/AppView.js', 'text/javascript'], ['controllers/AppController.js', 'text/javascript']
  ]);
  const server = http.createServer((req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(403).end(); return;
    }
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { res.writeHead(400).end(); return; }
    if (!url.pathname.startsWith(`/${token}/`)) { res.writeHead(404).end(); return; }
    const name = url.pathname.slice(token.length + 2);
    let file, mime;
    if (name === 'audio') {
      file = getAudioPath();
      const types = { '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.flac':'audio/flac' };
      mime = types[path.extname(file || '').toLowerCase()];
      if (!file || !mime) { res.writeHead(404).end(); return; }
    } else if (allowed.has(name)) {
      file = path.join(rendererDir, name); mime = allowed.get(name);
    } else { res.writeHead(404).end(); return; }
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) { res.writeHead(404).end(); return; }
      let start = 0, end = stat.size - 1, status = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
        start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end; status = 206;
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
      }
      const headers = {
        'Content-Type': mime, 'Content-Length': end - start + 1,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Accept-Ranges': 'bytes'
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      if (name.endsWith('.html')) {
        headers['Content-Security-Policy'] = name === 'player.html'
          ? "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' data: https:; connect-src 'self' https://www.youtube.com; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
          : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
      }
      res.writeHead(status, headers);
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}/${token}/` };
}
module.exports = { startServer };
