// An explicit allowlist: never serve the project root, server code, or .env files.
export const PUBLIC_FILES = new Map([
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/site.js', ['assets/site.js', 'text/javascript; charset=utf-8']],
  ['/assets/logos/i2t-logo-small-navy.png', ['assets/logos/i2t-logo-small-navy.png', 'image/png']],
  ['/assets/logos/i2t-logo-with-URL-navy.png', ['assets/logos/i2t-logo-with-URL-navy.png', 'image/png']],
  ['/assets/videos/demo-standard.mp4', ['assets/videos/demo-standard.mp4', 'video/mp4']],
  ['/assets/videos/demo-instagram.mp4', ['assets/videos/demo-instagram.mp4', 'video/mp4']]
]);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
