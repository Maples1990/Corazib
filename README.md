# Corazon Creative Co.

Corazon Creative Co. is a custom apparel website with a public marketing page, secure order and contact forms, and an owner-only admin dashboard.

## Run locally

1. Install dependencies:
   `npm install`
2. Start the server:
   `npm start`
3. Open:
   `http://localhost:3000`

## Environment variables

Use `.env.example` as the template for production values.

Local development in this workspace uses `.env` with:

- `PORT=3000`
- `APP_BASE_URL=http://localhost:3000`
- `ADMIN_EMAIL=maria@corazoncreativeco.com`
- `ALLOW_DEV_ADMIN_CODE_RESPONSE=true`

For production:

- Set a strong unique `SESSION_SECRET`
- Set `APP_BASE_URL` to the real HTTPS domain
- Set `CANONICAL_HOST` to the hostname you want to keep, such as `corazoncreativeco.com`
- Set `APP_ALLOWED_ORIGINS` if you want to temporarily allow an additional origin such as `https://www.corazoncreativeco.com`
- Turn `ALLOW_DEV_ADMIN_CODE_RESPONSE` off
- Configure SMTP credentials so admin sign-in codes and notifications are delivered by email

## Admin dashboard

The dashboard is available at `/admin`.

Local development behavior:

- Request a sign-in code using the admin email
- Because `ALLOW_DEV_ADMIN_CODE_RESPONSE=true`, the one-time code is returned in the API response for testing

Production behavior:

- The admin requests a sign-in code
- The code is emailed to `maria@corazoncreativeco.com`
- After verification, the dashboard can review submissions and update status or notes

## Data storage

- Submissions are stored in `data/store.json`
- This file is ignored by git and created automatically

If you want multi-device admin access in production, move this data to a hosted database instead of local JSON storage.

## Security included

- Same-origin validation for unsafe API requests
- HttpOnly admin session cookie with `SameSite=Strict`
- Rate limiting on public and admin endpoints
- Honeypot spam field support for forms
- Content Security Policy and related security headers
- Server-side validation for email and required fields
- Admin-only protected routes for dashboard data and updates

## Deployment notes

This app should be hosted on a Node-compatible platform or server. Squarespace can still be used only for the domain and DNS.

Recommended production setup:

1. Host the app behind HTTPS
2. Point the custom domain to the hosting provider
3. Set the production `.env` values on the host
4. Configure SMTP for admin sign-in codes and notification emails
5. Replace local JSON storage with a database if long-term growth or multi-user admin access is expected

### ApexPaaS notes

This repo now includes a `Dockerfile`, so it can be deployed as a containerized public service.

Typical ApexPaaS setup:

1. Create a new public service from this repo or Docker build
2. Expose container port `3000`
3. Set the production environment variables
4. Attach both `corazoncreativeco.com` and `www.corazoncreativeco.com` as custom domains
5. Copy the DNS records ApexPaaS provides into Squarespace DNS

Example production domain settings:

- `APP_BASE_URL=https://corazoncreativeco.com`
- `CANONICAL_HOST=corazoncreativeco.com`
- `APP_ALLOWED_ORIGINS=https://www.corazoncreativeco.com`