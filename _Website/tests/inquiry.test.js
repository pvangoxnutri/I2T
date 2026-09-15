import test from 'node:test';
import assert from 'node:assert/strict';
import { createInquiryHandler, createRateLimiter } from '../server/inquiry.js';

const env = { RESEND_API_KEY: 'test-secret-not-real', CONTACT_TO_EMAIL: 'contact@image2transition.com' };
const good = { name: '  Alex <Owner>  ', email: ' alex@example.com ', company: ' A & B ', message: ' Hello <script>alert("x")</script>\r\nThanks. ', website: '', inquiryType: 'agency' };
const origin = 'http://127.0.0.1:5173';
function request(data = good, headers = {}, raw) {
  return new Request(origin + '/api/inquiry', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(data) });
}
function fixture(fetchImpl = async () => Response.json({ id: 'mock-email-id' })) {
  const calls = [];
  const handler = createInquiryHandler({ now: () => Date.parse('2026-09-12T10:00:00Z'), rateLimit: () => 0,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } });
  return { calls, handle: (req, config = env) => handler(req, config, { clientKey: 'local-test' }) };
}

test('valid inquiry: fixed recipient, visitor reply-to, trimmed text, escaped HTML and server timestamp', async () => {
  const f = fixture();
  const id = '11111111-2222-4333-8444-555555555555';
  const result = await f.handle(request(good, { 'idempotency-key': id }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(options.headers.Authorization, 'Bearer test-secret-not-real');
  assert.equal(options.headers['Idempotency-Key'], 'i2t-' + id);
  const mail = JSON.parse(options.body);
  assert.deepEqual(mail.to, ['contact@image2transition.com']);
  assert.equal(mail.from, 'Image2Transition <onboarding@resend.dev>');
  assert.equal(mail.reply_to, 'alex@example.com');
  assert.equal(mail.subject, 'Image2Transition website inquiry — Alex <Owner>');
  assert.match(mail.text, /Company: A & B/);
  assert.match(mail.text, /2026-09-12T10:00:00.000Z/);
  assert.match(mail.text, /Software \/ Agency/);
  assert.match(mail.html, /Alex &lt;Owner&gt;/);
  assert.match(mail.html, /A &amp; B/);
  assert.match(mail.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>Thanks\./);
  assert.doesNotMatch(mail.html, /<script>/);
});

test('invalid fields never reach the email provider', async () => {
  const variants = [
    { name: '' }, { name: '  ' }, { name: 'A\nB' }, { name: 'x'.repeat(121) }, { name: 3 },
    { email: 'wrong' }, { email: 'a..b@example.com' }, { email: 'a@example.com\r\nBcc:x@y.com' },
    { email: 'a@-example.com' }, { email: 'a'.repeat(65) + '@example.com' },
    { message: '' }, { message: '\n\t ' }, { message: 'x'.repeat(4001) }, { message: '<a>\0' },
    { company: 'x'.repeat(201) }, { company: {} }, { website: [] }, { website: 'x'.repeat(501) },
    { inquiryType: '__proto__' }, { to: 'attacker@example.com' }, { from: 'attacker@example.com' }
  ];
  for (const changes of variants) {
    const f = fixture();
    assert.equal((await f.handle(request({ ...good, ...changes }))).status, 400, JSON.stringify(changes));
    assert.equal(f.calls.length, 0);
  }
  for (const value of [null, [], 'hello', {}]) {
    const f = fixture();
    assert.equal((await f.handle(request(value))).status, 400);
    assert.equal(f.calls.length, 0);
  }
});

test('honeypot returns success without sending, including without an API key', async () => {
  const f = fixture();
  const result = await f.handle(request({ ...good, website: 'https://spam.example' }), {});
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
  assert.equal(f.calls.length, 0);
});

test('method, origin, media type, JSON size and syntax boundaries', async () => {
  const f = fixture();
  assert.equal((await f.handle(new Request(origin + '/api/inquiry'))).status, 405);
  assert.equal((await f.handle(request(good, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await f.handle(request(good, { origin: '' }))).status, 403);
  assert.equal((await f.handle(request(good, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await f.handle(request(good, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await f.handle(request(good, {}, '{bad'))).status, 400);
  assert.equal((await f.handle(request(good, { 'content-length': '99999' }))).status, 413);
  assert.equal((await f.handle(request(good, {}, ' '.repeat(32769)))).status, 413);
  assert.equal((await f.handle(request(good, { 'idempotency-key': 'invalid' }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('missing server configuration and upstream errors never leak secrets or details', async () => {
  const f = fixture();
  assert.equal((await f.handle(request(), {})).status, 503);
  assert.equal((await f.handle(request(), { ...env, CONTACT_TO_EMAIL: 'invalid' })).status, 503);
  assert.equal(f.calls.length, 0);
  for (const provider of [
    async () => Response.json({ error: 'test-secret-not-real private diagnostics' }, { status: 403 }),
    async () => { throw new Error('test-secret-not-real private diagnostics'); },
    async () => Response.json({}),
    async () => new Response('not JSON')
  ]) {
    const result = await fixture(provider).handle(request());
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = await result.text();
    assert.doesNotMatch(body, /test-secret|private diagnostics/);
    assert.match(body, /contact@image2transition.com/);
  }
});

test('rate limit is per trusted client and expires, with a bounded client map', async () => {
  const rateLimit = createRateLimiter({ limit: 2, windowMs: 1000, maxClients: 2 });
  const handler = createInquiryHandler({ rateLimit, now: () => 0 });
  assert.equal((await handler(request(), {}, { clientKey: 'a' })).status, 503);
  assert.equal((await handler(request(), {}, { clientKey: 'a' })).status, 503);
  const blocked = await handler(request(), {}, { clientKey: 'a' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  assert.equal(rateLimit('b', 0), 0);
  assert.equal(rateLimit('c', 0), 1);
  assert.equal(rateLimit('a', 1000), 0);
  assert.equal(rateLimit('c', 1000), 0);
});

/**
 * THE MOTION LEVEL THE VISITOR PRICED IS THE ONE WE QUOTE BACK.
 *
 * The surcharge shown in the calculator depends on this field, so it has
 * to survive the trip: chosen in the form, carried in the payload, and
 * stated in the email that reaches the inbox. An inquiry that arrives
 * without it is a Standard inquiry, which is what every inquiry sent
 * before the choice existed was.
 */
test('video smoothness travels from the form into the email', async () => {
  const premium = fixture();
  await premium.handle(request({ ...good, motionQuality: 'premium120' }));
  const premiumMail = JSON.parse(premium.calls[0][1].body);
  assert.match(premiumMail.text, /Video smoothness: Premium Smooth — 120 FPS \(\+10%\)/);
  assert.match(premiumMail.html, /Premium Smooth — 120 FPS/);

  const standard = fixture();
  await standard.handle(request({ ...good, motionQuality: 'standard60' }));
  assert.match(JSON.parse(standard.calls[0][1].body).text, /Video smoothness: Standard — 60 FPS/);

  // Omitted reads as Standard rather than failing or inventing a surcharge.
  const absent = fixture();
  await absent.handle(request({ ...good }));
  assert.match(JSON.parse(absent.calls[0][1].body).text, /Video smoothness: Standard — 60 FPS/);

  // An unknown level is refused, not coerced: it decides a price.
  const bogus = fixture();
  const refused = await bogus.handle(request({ ...good, motionQuality: 'ultra240' }));
  assert.equal(refused.status, 400);
  assert.equal(bogus.calls.length, 0, 'a bad level never reaches the provider');
});
