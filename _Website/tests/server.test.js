import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDevServer } from '../server/dev.js';
import { createInquiryHandler } from '../server/inquiry.js';

test('local HTTP server exposes only public files, supports MP4 ranges, and routes the form', async t => {
  let sends = 0;
  const handler = createInquiryHandler({ fetchImpl: async () => { sends++; return Response.json({ id: 'mock' }); } });
  const server = createDevServer({ env: { RESEND_API_KEY: 'fake-private-key' }, handler });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/index.html', '/assets/site.js', '/assets/logos/i2t-logo-small-navy.png', '/assets/logos/i2t-logo-with-URL-navy.png']) {
    const result = await fetch(base + path);
    assert.equal(result.status, 200, path);
    assert.ok(result.headers.get('content-security-policy'));
    assert.doesNotMatch(await result.text(), /fake-private-key|RESEND_API_KEY/);
  }
  for (const path of ['/.env.local', '/.env.example', '/%2eenv.local', '/package.json', '/server/inquiry.js', '/functions/api/inquiry.js', '/tests/inquiry.test.js', '/scratch/website-preview/check.cjs', '/.git/config']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  for (const file of ['demo-standard.mp4', 'demo-instagram.mp4']) {
    const url = base + '/assets/videos/' + file;
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    const size = Number(head.headers.get('content-length'));
    assert.ok(size > 1000000);
    const partial = await fetch(url, { headers: { range: 'bytes=0-31' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-31/${size}`);
    assert.equal((await partial.arrayBuffer()).byteLength, 32);
    const tail = await fetch(url, { headers: { range: 'bytes=-32' } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 32);
    assert.equal((await fetch(url, { headers: { range: `bytes=${size}-` } })).status, 416);
    assert.equal((await fetch(url, { headers: { range: 'bytes=0-1,4-5' } })).status, 416);
  }
  const body = JSON.stringify({ name: 'Local test', email: 'test@example.com', message: 'Mock delivery only.' });
  const response = await fetch(base + '/api/inquiry', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(sends, 1);
  const crossOrigin = await fetch(base + '/api/inquiry', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body });
  assert.equal(crossOrigin.status, 403);
  assert.equal(sends, 1);
});
