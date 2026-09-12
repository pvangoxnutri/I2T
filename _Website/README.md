# Image2Transition website

Static website with a server-side inquiry endpoint. No desktop application or video export code is involved.

## Run locally

Requires Node.js 22.15 or newer. From PowerShell:

```powershell
cd C:\code\I2T\_Website
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Set `PORT` to use another port (PowerShell: `$env:PORT = '5174'` before `npm run dev`). The server binds only to the local machine. No third-party dependencies are installed. Stop this website server with Ctrl+C when finished.

## Configure email

Put the Resend API key in **`_Website/.env.local`**, never in HTML, browser JavaScript or a committed file. On a fresh checkout, create this ignored file using `.env.example` as the reference. Restart the website dev server after changing environment values.

```dotenv
RESEND_API_KEY=your-key-here
CONTACT_TO_EMAIL=contact@image2transition.com
CONTACT_FROM_EMAIL=contact@image2transition.com
```

The intended sender and recipient are both `contact@image2transition.com`. The owner has confirmed that `image2transition.com` is verified in Resend and local delivery works. Use an API key from the team owning that verified domain, with sending permission for it. Preserve the existing incoming email/forwarding configuration. Resend is used only for outbound form submissions; the visitor's validated email becomes Reply-To. Always configure `CONTACT_FROM_EMAIL` explicitly: the handler's legacy development fallback `onboarding@resend.dev` is restricted to the Resend account email and is not the production sender.

Official reference: [Resend development sender restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain), [Send email API](https://resend.com/docs/api-reference/emails/send-email).

An API success means Resend accepted the message, not that inbox delivery was confirmed. Check the Resend delivery event and the receiving mailbox separately. The automated checks mock Resend and send **no real email**. Once configured, submit just one clearly identified local test inquiry, then verify delivery.

## Frontend and endpoint

`index.html` retains the commercial sections and existing assets. `assets/site.js` handles the calculator, inquiry CTA selection, mobile navigation and form states. The compact form includes the existing inquiry type plus Name, Email, optional Company and Message. The pricing CTA can copy its estimate into an empty message. There are no uploads or attachments.

The browser posts JSON to `/api/inquiry`. `server/inquiry.js` contains the shared, Web-standard email handler. `server/dev.js` serves the page and endpoint locally. Public files are explicitly listed in `server/public-files.js`; environment files, server code, tests and development files are never served.

The handler validates and trims every field, rejects unknown fields and oversized bodies, escapes HTML, keeps the recipient server-controlled, checks same-origin requests, and uses a hidden honeypot. It limits each trusted client to five attempts per ten minutes per server instance. Request errors reveal no provider diagnostics. A retry identifier is forwarded to Resend to avoid duplicate sends after an ambiguous timeout (Resend's idempotency retention is 24 hours). Editing the form creates a new attempt.

The honeypot is intentionally acknowledged without sending. Missing configuration and provider failures show a general error and preserve the visitor's draft. Secrets are ignored by the local `.gitignore` and are excluded from the build. No inquiry data is persisted locally. The server does not log visitor data, API keys or provider response bodies.

## Checks and build

```powershell
npm test
npm run build
```

Tests cover simulated delivery, validation, HTML escaping, honeypot suppression, origin checks, payload size, errors, rate limiting, secret-file exclusion and video byte ranges. `npm run build` regenerates only `_Website/dist` from the explicit public allowlist. Never publish the entire `_Website` source directory as static files.

## Cloudflare Pages production configuration

Connect the GitHub repository to Cloudflare Pages with these settings:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Root directory | `_Website` |
| Build command | `npm run build` |
| Build output directory | `dist` (relative to `_Website`) |
| Build environment variable | `NODE_VERSION=24.15.0` |

`functions/api/inquiry.js` maps `/api/inquiry` to the shared handler through Pages Functions and obtains configuration from `env`. The endpoint uses Web-standard APIs; no Node compatibility flag or production Node server is required. Keep `functions` in the project root, outside `dist`. Use Pages Git integration, which bundles Functions; do not upload just `dist` through the dashboard's static-only upload flow.

Configure `RESEND_API_KEY` as an encrypted Pages secret, and `CONTACT_TO_EMAIL` and `CONTACT_FROM_EMAIL` as environment variables. Configure preview and production separately; do not give public previews production email access unintentionally. Local `.env.local` is not uploaded or used by Pages. For a future Wrangler preview, provide local bindings through an ignored `.dev.vars` file.

| Production binding | Value |
| --- | --- |
| `RESEND_API_KEY` | Your actual Resend key, stored as an encrypted secret |
| `CONTACT_TO_EMAIL` | `contact@image2transition.com` |
| `CONTACT_FROM_EMAIL` | `contact@image2transition.com` |

Set these before the first deployment, or redeploy after changing them. `PORT` is only for the local development server and is not required in Cloudflare.

The build includes CSP/security headers and a `_routes.json` restricting function invocations to `/api/*`. Before making the endpoint public, add an edge rate-limit rule for POST `/api/inquiry` (or a shared rate limiter). The existing in-memory guard is per isolate and cannot enforce a global limit across Cloudflare instances. Honeypots and Origin headers are lightweight measures, not complete protection against direct automated HTTP clients. No CAPTCHA has been added.

Connect `image2transition.com` under Pages Custom domains and confirm HTTPS, then test one end-to-end delivery after deployment. No Cloudflare account settings are changed by the local build or tests.

Official reference: [Pages Functions routing](https://developers.cloudflare.com/pages/functions/routing/), [Pages environment variables and secrets](https://developers.cloudflare.com/pages/functions/bindings/).

## Local verification completed

- All eight automated test groups and `npm run build` passed, including a simulated request through the Cloudflare Pages entry point using production HTTPS and environment bindings.
- Chrome checks passed at 1440×900, 1366×768, 1280×720, 768×1024, 390×844 and 320×740, with no horizontal overflow. Logo loading, both videos playing, calculator totals and invalid counts, and CTA inquiry selection/scrolling were checked.
- The actual HTTP endpoint was exercised from the browser with a simulated Resend response: invalid email and blank message were blocked; the button and fields were disabled during sending; success cleared the form; provider failure retained the draft and showed a general error; the honeypot sent no email. Browser source and outgoing inquiry requests contained no test API key.
- Static access to secret/server files was rejected, video byte-range requests worked, and generated public output was checked against the allowlist.
- No real emails were sent during the launch-readiness checks. Domain verification and working local delivery were confirmed by the owner; automated checks use a mocked provider.
- Existing demo source files and their webpage fitting behavior remain unchanged for the form task. The browser reports both existing MP4 files as 1920×1080; the Instagram preview still uses its existing portrait wrapper. No media file or export pipeline was modified.

The two public demo MP4s are explicitly allowed by `_Website/.gitignore` so fresh checkouts contain every asset used by the build. Local secrets, build output, caches, screenshots, browser profiles and test reports remain ignored. Publish source/configuration and the four public logo/video assets, never the generated `dist/` directory or local verification artifacts.
