import test from 'node:test';
import assert from 'node:assert/strict';

test('Pages route sends through server env bindings on the production HTTPS origin', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: 'mock-pages-email' });
  });
  // Import after mocking fetch: no live provider request or local secret is used.
  const { onRequest } = await import('../functions/api/inquiry.js');
  const origin = 'https://image2transition.com';
  const request = new Request(origin + '/api/inquiry', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify({ name: 'Pages test', email: 'visitor@example.com', message: 'Simulated production request.' })
  });
  const result = await onRequest({ request, env: {
    RESEND_API_KEY: 'mock-pages-secret',
    CONTACT_TO_EMAIL: 'contact@image2transition.com',
    CONTACT_FROM_EMAIL: 'contact@image2transition.com'
  } });
  assert.equal(result.status, 200);
  const responseBody = await result.text();
  assert.equal(JSON.parse(responseBody).ok, true);
  assert.doesNotMatch(responseBody, /mock-pages-secret/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer mock-pages-secret');
  const email = JSON.parse(calls[0].options.body);
  assert.equal(email.from, 'Image2Transition <contact@image2transition.com>');
  assert.deepEqual(email.to, ['contact@image2transition.com']);
  assert.equal(email.reply_to, 'visitor@example.com');

  const missing = await onRequest({ request: new Request(origin + '/api/inquiry', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.2' },
    body: JSON.stringify({ name: 'Pages test', email: 'visitor@example.com', message: 'Missing binding test.' })
  }), env: {} });
  assert.equal(missing.status, 503);
  assert.equal(calls.length, 1, 'Missing Pages bindings do not fall back to local secrets');
});
