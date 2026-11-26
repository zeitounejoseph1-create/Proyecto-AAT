// Local development only. Serve an explicit public-file allowlist, never SQL/env/test files.
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const handler = require('../api/reservations.js');
const config = require('../vercel.json');
const root = path.resolve(__dirname, '..');
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/assets/app.js': ['assets/app.js', 'text/javascript; charset=utf-8'], '/assets/styles.css': ['assets/styles.css', 'text/css; charset=utf-8'] };

function createAppServer({ afterApi } = {}) {
  return http.createServer(async (req, res) => {
    for (const header of config.headers[0].headers) res.setHeader(header.key, header.value);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/reservations') {
      const query = {};
      for (const key of url.searchParams.keys()) { const values = url.searchParams.getAll(key); query[key] = values.length === 1 ? values[0] : values; }
      req.query = query;
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) { res.writeHead(413); res.end('{}'); return; }
      }
      req.body = body || undefined;
      if (afterApi) {
        const end = res.end.bind(res);
        res.end = data => afterApi(req, res, data, end);
      }
      await handler(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) || !files[url.pathname]) { res.writeHead(404); res.end('Not found'); return; }
    const [file, type] = files[url.pathname];
    try { const body = await readFile(path.join(root, file)); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body); }
    catch { res.writeHead(500); res.end('Could not load public file'); }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, '127.0.0.1', () => console.log(`MesaLista: http://127.0.0.1:${port}`));
}
module.exports = { createAppServer };
