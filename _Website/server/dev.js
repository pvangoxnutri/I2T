import { createServer } from 'node:http';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createInquiryHandler } from './inquiry.js';
import { PUBLIC_FILES, SECURITY_HEADERS } from './public-files.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createDevServer({ env = process.env, handler = createInquiryHandler() } = {}) {
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
    }
    let url;
    try { url = new URL(req.url, `http://${host}`); }
    catch { res.writeHead(400, SECURITY_HEADERS); res.end('Bad request'); return; }
    if (url.origin !== `http://${host}`) {
      res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
    }
    try {
      if (url.pathname === '/api/inquiry') {
        const request = new Request(url, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
        // Never trust a client-supplied X-Forwarded-For header on the local server.
        const result = await handler(request, env, { clientKey: req.socket.remoteAddress });
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(await result.text()); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
      }
      const asset = PUBLIC_FILES.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!asset) { res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return; }
      const [relative, type] = asset;
      const file = join(ROOT, relative);
      const { size } = statSync(file);
      const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      let start = 0, end = size - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        } else start = -1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return;
        }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('The request could not be completed.');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = join(ROOT, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || 5173);
  const server = createDevServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. No existing process was stopped.` : 'The local website server could not start.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Image2Transition: http://127.0.0.1:${port}`);
    console.log(process.env.RESEND_API_KEY?.trim() ? 'Inquiry email configuration loaded.' : 'Add RESEND_API_KEY to .env.local to enable live inquiry delivery.');
  });
}
