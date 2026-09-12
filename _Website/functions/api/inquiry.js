import { handleInquiry } from '../../server/inquiry.js';

// Cloudflare Pages route: POST /api/inquiry. env holds server-side secrets.
export function onRequest({ request, env }) {
  return handleInquiry(request, env, { clientKey: request.headers.get('CF-Connecting-IP') || 'unknown' });
}
