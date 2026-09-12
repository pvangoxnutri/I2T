// Web-standard Request/Response handler shared by Node and Cloudflare Pages.
// Secrets are supplied by the server environment, never by the request body.
const MAX_BODY_BYTES = 32 * 1024;
const SUCCESS = { ok: true, message: 'Thank you. Your inquiry has been sent.' };
const SEND_ERROR = 'We couldn’t send your inquiry. Please try again or email contact@image2transition.com.';
const TYPES = { video: 'Create a video', agency: 'Software / Agency', partnership: 'Partnership', other: 'Other' };
const ALLOWED_FIELDS = new Set(['name', 'email', 'company', 'message', 'website', 'inquiryType']);

function response(status, body, extraHeaders = {}) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders
  } });
}

export function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && /^[a-z]{2,63}$/i.test(labels.at(-1)) &&
    labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some(key => !ALLOWED_FIELDS.has(key))) return null;
  for (const key of ['name', 'email', 'message']) if (typeof payload[key] !== 'string') return null;
  for (const key of ['company', 'website', 'inquiryType']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'string') return null;
  }
  const data = {
    name: payload.name.trim(), email: payload.email.trim(), company: (payload.company ?? '').trim(),
    message: payload.message.replace(/\r\n?/g, '\n').trim(), website: (payload.website ?? '').trim(),
    inquiryType: payload.inquiryType ?? 'other'
  };
  if (!data.name || data.name.length > 120 || /[\x00-\x1f\x7f]/.test(data.name)) return null;
  if (!validEmail(data.email) || data.company.length > 200 || /[\x00-\x1f\x7f]/.test(data.company)) return null;
  if (!data.message || data.message.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.message)) return null;
  if (data.website.length > 500 || !Object.hasOwn(TYPES, data.inquiryType)) return null;
  return data;
}

async function readLimitedJson(request) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new RangeError('body');
  }
  if (!request.body) throw new SyntaxError('body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// Local/per-isolate abuse guard. Production also needs an edge rate-limit rule;
// Cloudflare instances do not share this in-memory map.
export function createRateLimiter({ limit = 5, windowMs = 10 * 60_000, maxClients = 5000 } = {}) {
  const clients = new Map();
  return (client, time) => {
    for (const [key, entry] of clients) if (entry.expires <= time) clients.delete(key);
    let entry = clients.get(client);
    if (!entry) {
      if (clients.size >= maxClients) return Math.ceil(windowMs / 1000);
      entry = { count: 0, expires: time + windowMs };
      clients.set(client, entry);
    }
    if (++entry.count > limit) return Math.max(1, Math.ceil((entry.expires - time) / 1000));
    return 0;
  };
}

export function createInquiryHandler({ fetchImpl = fetch, now = () => Date.now(), rateLimit = createRateLimiter() } = {}) {
  return async function handleInquiry(request, env, { clientKey = 'unknown' } = {}) {
    if (request.method !== 'POST') return response(405, { ok: false, error: 'Use the inquiry form to send a message.' }, { Allow: 'POST' });
    const ownOrigin = new URL(request.url).origin;
    if (request.headers.get('origin') !== ownOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return response(403, { ok: false, error: 'Please send your inquiry from this website.' });
    }
    const retryAfter = rateLimit(clientKey, now());
    if (retryAfter) return response(429, { ok: false, error: 'Please wait a few minutes before sending another inquiry.' }, { 'Retry-After': String(retryAfter) });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return response(415, { ok: false, error: 'Please use the inquiry form to send your message.' });
    }
    let payload;
    try { payload = await readLimitedJson(request); }
    catch (error) { return response(error instanceof RangeError ? 413 : 400, { ok: false, error: 'Please check your inquiry and try again.' }); }
    const data = validatePayload(payload);
    if (!data) return response(400, { ok: false, error: 'Please enter a valid name, email address and message.' });
    // Bots receive the same success response, but no email is sent.
    if (data.website) return response(200, SUCCESS);

    const key = env.RESEND_API_KEY?.trim();
    const to = env.CONTACT_TO_EMAIL?.trim() || 'contact@image2transition.com';
    const from = env.CONTACT_FROM_EMAIL?.trim() || 'onboarding@resend.dev';
    if (!key || !validEmail(to) || !validEmail(from)) return response(503, { ok: false, error: SEND_ERROR });
    const suppliedId = request.headers.get('idempotency-key');
    if (suppliedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId)) {
      return response(400, { ok: false, error: 'Please reload the page and try again.' });
    }
    const timestamp = new Date(now()).toISOString();
    const details = [
      ['Name', data.name], ['Email', data.email], ['Company', data.company || 'Not provided'],
      ['Inquiry', TYPES[data.inquiryType]], ['Timestamp (UTC)', timestamp]
    ];
    const text = details.map(([label, value]) => `${label}: ${value}`).join('\n') + '\n\nMessage:\n' + data.message;
    const html = '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111c33;line-height:1.6">' +
      '<h2>Image2Transition website inquiry</h2>' +
      details.map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`).join('') +
      `<h3>Message</h3><p>${escapeHtml(data.message).replace(/\n/g, '<br>')}</p></body></html>`;
    try {
      const sent = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `i2t-${suppliedId || crypto.randomUUID()}` },
        body: JSON.stringify({ from: `Image2Transition <${from}>`, to: [to], reply_to: data.email,
          subject: `Image2Transition website inquiry — ${data.name}`, text, html }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!sent.ok) {
        // Log only a status code. Never log provider bodies, keys, or visitor data.
        console.warn(`[inquiry] Email provider returned HTTP ${sent.status}.`);
        return response(502, { ok: false, error: SEND_ERROR });
      }
      const result = await sent.json();
      if (typeof result?.id !== 'string' || !result.id) return response(502, { ok: false, error: SEND_ERROR });
      return response(200, SUCCESS);
    } catch {
      return response(502, { ok: false, error: SEND_ERROR });
    }
  };
}

export const handleInquiry = createInquiryHandler();
