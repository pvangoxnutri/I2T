// Web-standard Request/Response handler shared by Node and Cloudflare Pages.
// Secrets are supplied by the server environment, never by the request body.
const MAX_BODY_BYTES = 32 * 1024;
const SUCCESS = { ok: true, message: 'Thank you. Your inquiry has been sent.' };
const SEND_ERROR = 'We couldn’t send your inquiry. Please try again or email contact@image2transition.com.';
const TYPES = { video: 'Create a video', agency: 'Software / Agency', partnership: 'Partnership', other: 'Other' };
const ALLOWED_FIELDS = new Set(['name', 'email', 'company', 'message', 'website', 'inquiryType', 'motionQuality']);
// Customer-facing wording for the two motion levels. Standard is the
// default for an inquiry that does not name one, which is what every
// inquiry sent before the choice existed did.
const QUALITIES = { standard60: 'Standard — 60 FPS', premium120: 'Premium Smooth — 120 FPS (+10%)' };
const ENV_NAMES = ['RESEND_API_KEY', 'CONTACT_TO_EMAIL', 'CONTACT_FROM_EMAIL'];
// Development conveniences, never production values. `onboarding@resend.dev`
// is Resend's sandbox sender and may only deliver to the Resend account's own
// address, so a production deployment that silently adopted it would fail with
// a 403 on every real inquiry. `requireExplicitEnv` keeps both out of the
// production path — see where they are applied below.
const DEV_RECIPIENT = 'contact@image2transition.com';
const DEV_SENDER = 'onboarding@resend.dev';
const PROVIDER_ERROR_NAMES = new Set([
  'validation_error', 'missing_api_key', 'invalid_api_key', 'restricted_api_key',
  'invalid_access', 'rate_limit_exceeded', 'application_error', 'internal_server_error',
  'missing_required_field', 'invalid_parameter', 'not_found', 'method_not_allowed',
  'invalid_region', 'invalid_idempotent_request', 'concurrent_idempotent_requests',
  'daily_quota_exceeded', 'monthly_quota_exceeded'
]);

function safeProviderError(body) {
  // Only fixed, reviewed descriptions enter logs. Provider messages can echo
  // credentials or visitor fields, so never log raw bodies or arbitrary text.
  const name = PROVIDER_ERROR_NAMES.has(body?.name) ? body.name : 'unknown_error';
  const message = typeof body?.message === 'string' ? body.message : '';
  const descriptions = [
    [/^The [a-z0-9.-]+ domain is not verified\./i, 'The sending domain is not verified in Resend.'],
    [/^You can only send testing emails to your own email address/i, 'The development sender is restricted to the Resend account email address.'],
    [/^(?:API key is invalid|Invalid API key)\.?$/i, 'The API key is invalid.'],
    [/^Missing API key\.?$/i, 'The API key is missing.'],
    [/^This API key is restricted/i, 'The API key does not have the required sending permission.'],
    [/^Invalid `?from`? field/i, 'The sender field is invalid.'],
    [/^Too many requests/i, 'Resend rate limit exceeded.'],
    [/^You have reached your (?:daily|monthly) email/i, 'Resend email quota exceeded.'],
    [/^Same idempotency key used with different request payload/i, 'The retry identifier was reused with a different email payload.']
  ];
  return { name, message: descriptions.find(([pattern]) => pattern.test(message))?.[1] || 'Provider message omitted; inspect the Resend dashboard for further details.' };
}

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
  for (const key of ['company', 'website', 'inquiryType', 'motionQuality']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'string') return null;
  }
  const data = {
    name: payload.name.trim(), email: payload.email.trim(), company: (payload.company ?? '').trim(),
    message: payload.message.replace(/\r\n?/g, '\n').trim(), website: (payload.website ?? '').trim(),
    inquiryType: payload.inquiryType ?? 'other',
    // Absent reads as Standard: that is what an inquiry sent before the
    // choice existed asked for, and what the form pre-selects now.
    motionQuality: payload.motionQuality ?? 'standard60'
  };
  if (!data.name || data.name.length > 120 || /[\x00-\x1f\x7f]/.test(data.name)) return null;
  if (!validEmail(data.email) || data.company.length > 200 || /[\x00-\x1f\x7f]/.test(data.company)) return null;
  if (!data.message || data.message.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.message)) return null;
  if (data.website.length > 500 || !Object.hasOwn(TYPES, data.inquiryType)) return null;
  // An unknown level is refused rather than coerced — the surcharge the
  // visitor was shown depends on it, so it must be exactly one of two.
  if (!Object.hasOwn(QUALITIES, data.motionQuality)) return null;
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

export function createInquiryHandler({ fetchImpl = fetch, now = () => Date.now(), rateLimit = createRateLimiter(), logger = console } = {}) {
  return async function handleInquiry(request, env = {}, { clientKey = 'unknown', requireExplicitEnv = false } = {}) {
    // ANSWERS "DID THE REQUEST REACH THE FUNCTION AT ALL". Without this, a
    // deployment or routing fault and a configuration fault look identical
    // from the browser, because both end at the same generic message. The
    // method is the only field logged: no headers, no body, no visitor data.
    logger.info('[inquiry]', { event: 'request_received', method: request.method });
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

    const config = Object.fromEntries(ENV_NAMES.map(name => [name, typeof env[name] === 'string' ? env[name].trim() : '']));
    const required = requireExplicitEnv ? ENV_NAMES : ['RESEND_API_KEY'];
    const missing = required.filter(name => !config[name]);
    if (missing.length) {
      logger.error('[inquiry]', { event: 'configuration_missing', missing });
      return response(503, { ok: false, error: SEND_ERROR });
    }
    const key = config.RESEND_API_KEY;
    // ── THE SANDBOX SENDER CANNOT REACH PRODUCTION ──────────────────
    //
    // Production passes `requireExplicitEnv`, so an empty address was
    // already refused above with a named 503. Stating the condition here
    // too means the fallback is unreachable by construction rather than
    // by the ordering of an earlier check: no future edit can let a
    // missing CONTACT_FROM_EMAIL quietly become the restricted Resend
    // sandbox sender on the live site.
    const to = config.CONTACT_TO_EMAIL || (requireExplicitEnv ? '' : DEV_RECIPIENT);
    const from = config.CONTACT_FROM_EMAIL || (requireExplicitEnv ? '' : DEV_SENDER);
    const invalid = [['CONTACT_TO_EMAIL', to], ['CONTACT_FROM_EMAIL', from]].filter(([, value]) => !validEmail(value)).map(([name]) => name);
    if (invalid.length) {
      logger.error('[inquiry]', { event: 'configuration_invalid', invalid });
      return response(503, { ok: false, error: SEND_ERROR });
    }
    const suppliedId = request.headers.get('idempotency-key');
    if (suppliedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId)) {
      return response(400, { ok: false, error: 'Please reload the page and try again.' });
    }
    const timestamp = new Date(now()).toISOString();
    const details = [
      ['Name', data.name], ['Email', data.email], ['Company', data.company || 'Not provided'],
      ['Inquiry', TYPES[data.inquiryType]], ['Video smoothness', QUALITIES[data.motionQuality]],
      ['Timestamp (UTC)', timestamp]
    ];
    const text = details.map(([label, value]) => `${label}: ${value}`).join('\n') + '\n\nMessage:\n' + data.message;
    const html = '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111c33;line-height:1.6">' +
      '<h2>Image2Transition website inquiry</h2>' +
      details.map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`).join('') +
      `<h3>Message</h3><p>${escapeHtml(data.message).replace(/\n/g, '<br>')}</p></body></html>`;
    // ANSWERS "WAS THE PROVIDER EVER CALLED". A log line here with no
    // matching resend_response means the request died in transport rather
    // than being rejected by Resend. The booleans say whether the two
    // addresses came from configuration, which is what separates a real
    // sender from a development default; neither address is logged.
    logger.info('[inquiry]', {
      event: 'resend_attempt',
      fromConfigured: Boolean(config.CONTACT_FROM_EMAIL),
      toConfigured: Boolean(config.CONTACT_TO_EMAIL)
    });
    try {
      const sent = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `i2t-${suppliedId || crypto.randomUUID()}` },
        body: JSON.stringify({ from: `Image2Transition <${from}>`, to: [to], reply_to: data.email,
          subject: `Image2Transition website inquiry — ${data.name}`, text, html }),
        signal: AbortSignal.timeout(10_000)
      });
      logger.info('[inquiry]', { event: 'resend_response', status: sent.status });
      if (!sent.ok) {
        const providerError = await readLimitedJson(sent).catch(() => null);
        logger.error('[inquiry]', { event: 'resend_error', status: sent.status, ...safeProviderError(providerError) });
        return response(502, { ok: false, error: SEND_ERROR });
      }
      const result = await readLimitedJson(sent).catch(() => null);
      if (typeof result?.id !== 'string' || !result.id) {
        logger.error('[inquiry]', { event: 'resend_invalid_response', status: sent.status });
        return response(502, { ok: false, error: SEND_ERROR });
      }
      return response(200, SUCCESS);
    } catch (error) {
      logger.error('[inquiry]', { event: 'resend_request_failed', reason: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'transport_error' });
      return response(502, { ok: false, error: SEND_ERROR });
    }
  };
}

export const handleInquiry = createInquiryHandler();
