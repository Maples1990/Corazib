# Domain Setup

This project is ready to use a custom domain, but the final DNS records depend on where the Node app is hosted.

## Recommended domain shape

- Canonical domain: `corazoncreativeco.com`
- Redirect alias: `www.corazoncreativeco.com`

The app now supports:

- one canonical host for redirects
- one or more additional allowed origins for safe form submissions during migration

## Production environment values

Set these on the hosting provider:

```env
APP_BASE_URL=https://corazoncreativeco.com
CANONICAL_HOST=corazoncreativeco.com
APP_ALLOWED_ORIGINS=https://www.corazoncreativeco.com
ALLOW_DEV_ADMIN_CODE_RESPONSE=false
SESSION_SECRET=replace-with-a-long-random-secret
```

## Squarespace DNS workflow

Squarespace is only managing the domain and DNS here.

1. Keep the domain in Squarespace.
2. Deploy the Node app to a host that supports custom domains and HTTPS.
3. In that host, add both:
   - `corazoncreativeco.com`
   - `www.corazoncreativeco.com`
4. Copy the DNS records that host gives you.
5. In Squarespace DNS, create the required records.

## ApexPaaS-specific path

The project now includes a `Dockerfile`, which fits ApexPaaS's container deployment model.

1. Create a new public service in ApexPaaS from this project.
2. Use container port `3000`.
3. Add these environment variables in ApexPaaS:
   - `APP_BASE_URL=https://corazoncreativeco.com`
   - `CANONICAL_HOST=corazoncreativeco.com`
   - `APP_ALLOWED_ORIGINS=https://www.corazoncreativeco.com`
   - `ADMIN_EMAIL=maria@corazoncreativeco.com`
   - `SESSION_SECRET=...`
   - `SMTP_HOST=...`
   - `SMTP_PORT=587`
   - `SMTP_SECURE=false`
   - `SMTP_USER=...`
   - `SMTP_PASS=...`
   - `SMTP_FROM=Corazon Creative Co. <maria@corazoncreativeco.com>`
   - `ALLOW_DEV_ADMIN_CODE_RESPONSE=false`
4. Add both custom domains in ApexPaaS.
5. Copy the DNS targets ApexPaaS gives you into Squarespace.
6. Wait for SSL issuance, then test the live site and the admin sign-in flow.

Common patterns by host:

- If the host gives an `A` record for the apex domain, add it for `@`
- If the host gives a `CNAME` for `www`, add it for `www`
- If the host gives only a CNAME target, use Squarespace's DNS support for flattening or follow the host's apex-domain instructions

## What the app expects

- Visitors should end up on the canonical host defined by `APP_BASE_URL`
- Requests that arrive on a different host will redirect to the canonical host for normal page loads
- API requests are allowed only from trusted origins

## Before going live

1. Set SMTP credentials so Maria receives login codes and notifications.
2. Confirm HTTPS is active on the host.
3. Confirm `APP_BASE_URL` matches the exact live domain.
4. Turn off `ALLOW_DEV_ADMIN_CODE_RESPONSE`.
5. Submit one real test form on the live domain.