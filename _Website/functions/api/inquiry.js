import { handleInquiry } from '../../server/inquiry.js';

// Cloudflare Pages route: POST /api/inquiry. env holds server-side secrets.
export function onRequest(context) {
  const env = {
    RESEND_API_KEY: context.env?.RESEND_API_KEY,
    CONTACT_TO_EMAIL: context.env?.CONTACT_TO_EMAIL,
    CONTACT_FROM_EMAIL: context.env?.CONTACT_FROM_EMAIL
  };
  return handleInquiry(context.request, env, {
    clientKey: context.request.headers.get('CF-Connecting-IP') || 'unknown',
    requireExplicitEnv: true
  });
}
