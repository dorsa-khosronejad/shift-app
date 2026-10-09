# Shift & Care

A digital replacement for the paper shift sign-in sheet, plus a simple channel
for staff to flag workload, ergonomics, or safety concerns to their manager.
Built as a portfolio project — a working base you can demo, extend, and show
in interviews or to your manager.

## What's in here

```
shift-app/
  backend/          Node.js + Express API, SQLite database
  frontend/          Plain HTML/CSS/JS — no build step needed
```

Three roles: **employee** (clock in/out, send reports), **manager** (see the
team's shifts and incoming reports), **admin** (create/deactivate accounts).

## Running it locally

**1. Backend**

```
cd backend
npm install
cp .env.example .env    # then edit .env with real secrets (see below)
node server.js
```

The API runs on `http://localhost:4000`. On first run it creates
`db/shifts.db` and seeds three demo accounts (see below).

**2. Frontend**

The frontend is static files — no build step. Easiest way to run it locally
with working cookies is a simple static server, for example:

```
cd frontend
npx serve -l 5500
```

Then open `http://localhost:5500`. If you use a different port, update
`CORS_ORIGIN` in `backend/.env` to match.

Password recovery sends a one-time link by email. Configure `FRONTEND_URL`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and
`SMTP_FROM` in the backend environment. Do not commit SMTP credentials.

## Tests

Install the backend and root test dependencies, then run the complete suite:

```
npm --prefix backend install
npm install
npm test
```

The frontend suite runs real browser workflows in Chrome. It uses the macOS
Google Chrome application by default; set `CHROME_PATH` to another
Chromium-compatible executable when needed. The tests start isolated local
servers and a temporary database, so they do not use the configured app data.
Every run measures frontend coverage by instrumenting the served JavaScript with
Istanbul and prints a per-file report (also written to `coverage/`). The run
fails if line, function, or branch coverage drops below 70%, 70%, or 60%. The
service worker is exercised by a test but cannot report counters, so it is
listed at 0% rather than being left out of the total.
The suite is organized under `frontend/tests/`: `support/` owns browser and
server setup, `commands/` contains reusable user actions, and `specs/` contains
separate auth, employee, manager, and admin workflows.

## Demo accounts (seeded automatically)

| Role     | Email                | Password      |
|----------|-----------------------|---------------|
| Admin    | admin@demo.local      | Admin123!     |
| Manager  | manager@demo.local    | Manager123!   |
| Employee | employee@demo.local   | Employee123!  |

Change or remove these before this ever touches real data.

## How the login system works

This isn't a toy login form — it follows the same patterns a production app
would use, so it's worth understanding (and worth mentioning in an
interview):

- **Passwords** are hashed with bcrypt (12 salt rounds) — never stored in
  plain text, never logged.
- **Two-token model**: a short-lived (15 min) JWT *access token* is kept in
  memory on the frontend (never localStorage — that's readable by any
  injected script). A longer-lived (7 day) *refresh token* is stored in an
  `httpOnly`, `sameSite=strict` cookie — JavaScript can never read it, which
  limits what an XSS attack could steal.
- **Refresh token rotation**: every time the refresh token is used, it's
  revoked and replaced with a new one. A stolen-but-unused token becomes
  worthless the next time the real user refreshes.
- **Account lockout**: 5 failed login attempts locks the account for 15
  minutes. A rate limiter also caps login attempts per IP, independent of
  which account is being tried.
- **Generic error messages**: "incorrect email or password" never reveals
  whether the email exists — that alone can leak who's registered.
- **Role-based access control**: every sensitive route checks the user's
  role server-side (`requireRole('manager', 'admin')`) — the frontend hiding
  a button is never the actual security boundary.
- **No public self-registration**: accounts are created by an admin only.
  This is a staff tool with a controlled roster, not a public product.

## What still needs attention

- Integration tests exercise the main authentication, account, timekeeping,
  scheduling, leave, and reporting workflows. Direct backend tests also cover
  token and TOTP utilities, auth middleware, notification persistence, and
  SQLite backup/restore behavior. Coverage is not exhaustive: concurrency,
  deployment configuration, and frontend flows still need dedicated tests.
- In production, the refresh cookie uses `sameSite: 'none'` so the Netlify
  frontend can work with the Railway API across domains. This is a deliberate
  trade-off that weakens the browser's built-in CSRF protection; the API also
  checks request origins, but the cookie setting is still worth reviewing.
- Browser tests cover the invitation, scheduling, and open-shift claiming flows.
  Full visual/accessibility coverage and cross-browser testing remain open.

## About the "health" feature

Real employee health data (symptoms, diagnoses, sick leave reasons) is a
*special category* of personal data under GDPR — it needs a much stronger
legal basis, security review, and usually a data protection officer's sign-off
before you'd build it for real. To keep this useful without wandering into
that, the app deliberately only supports **workload / ergonomics / incident**
flags — no medical detail fields. If you want to extend this into real health
tracking later, that's the point where you'd want proper legal advice, not
just more code.

## Realistic next step

Scandic (or any hotel chain) won't buy software from an individual employee
directly — but a working prototype like this is a strong thing to show your
manager as a time/paper-saving idea, and a strong thing to bring to an IT job
interview as proof you can spot a real problem and build a working solution
for it.

## Suggested next features

- CSV export of shift data for payroll
- Weekly hours summary per employee
- Manager notes to the paper trail on odd shift patterns (e.g. very long open shift with no clock-out)
- Push/email notification when a wellbeing report comes in
