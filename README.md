# RCON Admin Panel

Next.js (App Router) application that drives a Factorio server: free-form RCON console, built-in
actions (players, save, moderation, chat), roles, audit log.

It speaks the RCON protocol over TCP — the repository's C client (`docker/rcon/main.c`) hardcodes
`127.0.0.1` and is only usable from within the server container.

## Development

```bash
cp .env.example .env.local   # set ADMIN_PASSWORD at minimum
npm install
npm run dev                  # http://localhost:3000
```

The Factorio server must be running with the RCON port published (`docker compose up -d factorio`,
`27015:27015/tcp` is already mapped). The RCON password is read from `../data/config/rconpw`,
generated on first server start by `docker/files/docker-entrypoint.sh`.

```bash
npm run lint        # eslint
npm run typecheck   # next typegen && tsc --noEmit
npm test            # vitest
npm run build
```

## Production

The `factorio-admin` service in the root `docker-compose.yml`:

```bash
cd .. && ./setup-admin.sh            # generates ../.env (passwords + session key)
docker compose up -d --build factorio-admin   # http://127.0.0.1:3010
```

`setup-admin.sh --all` also creates the moderator and viewer passwords, `--ask` prompts for them
instead of generating them, and `--force` rotates every secret (which ends open sessions). Values
already present in `.env` are kept by default.

An image is published on every release to `williamnauroy/factorio-admin-rcon` (`linux/amd64` and
`linux/arm64`). Pin an exact version in production:

```bash
docker pull williamnauroy/factorio-admin-rcon:1.0.0
```

Versioning and publishing are automated — see [CI.md](CI.md).

## Roles

One password per role; the role is determined by the password used to sign in.

| Role | Variable | Can do |
| --- | --- | --- |
| `viewer` | `VIEWER_PASSWORD` | Status, players, version, seed, evolution, admins, ban list |
| `moderator` | `MODERATOR_PASSWORD` | + kick, ban/unban, mute/unmute, server message, private message |
| `admin` | `ADMIN_PASSWORD` | + save, promote/demote, **raw RCON console**, audit log |

Permissions are enforced **server-side**: the action catalogue is filtered by role, and
`/api/actions` re-checks the permission before executing anything.

## Languages

The panel ships in English (default) and French. The language is inferred from the
`Accept-Language` header on first visit, can be changed from the switcher in the status bar, and is
remembered in a cookie. It shows up in the URL: `/` for English, `/fr` for French.

To add a language:

1. copy `messages/en.json` to `messages/<code>.json` and translate the values;
2. add the code to `locales` in `src/i18n/routing.ts`;
3. add its name under `localeSwitcher` in every dictionary;
4. `npm test` — the suite checks that all dictionaries expose exactly the same keys, that no
   catalogue action is missing a label, and that every message compiles as ICU.

No interface text lives in `src/server/`: the API returns identifiers only (`ban`, `moderation`)
and error codes (`rate_limited_session`, `validation_player`), which the interface translates. The
`error` field of JSON responses stays an **English** fallback, meant for non-browser callers. The
audit log stores identifiers too, so history stays readable in any language — including entries
written before a language was added.

Deliberately left untranslated: raw Factorio output, RCON commands, and server logs (English, aimed
at the operator).

## Architecture

```
src/
├── app/            pages + API routes (pages live under `[locale]/`)
├── components/     interface (console, actions, audit, modal)
├── hooks/          server status (polling), command execution, translations
├── i18n/           routing, dictionary loading, locale-aware navigation
├── lib/            shared client/server code (types, permissions, typed fetch)
└── server/         server-only code
    ├── actions/    business definitions + execution
    ├── audit/      SQLite log
    ├── auth/       accounts, sessions, rate limiters
    ├── config/     validated environment variables (zod)
    ├── http/       route wrapper (session, permission, origin, logs)
    └── rcon/       service, queue, parsing, status cache

messages/           dictionaries (en.json is the reference)
```

Two distinct execution paths:

- `POST /api/actions` — `{ action, values }`. The server validates the arguments, enforces the
  permission and **builds the command itself**. Used by every role.
- `POST /api/rcon` — raw command. Restricted to the `rcon:raw` permission (`admin` role).

## Endpoints

| Route | Auth | Role |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | — | Opens / revokes a session |
| `GET /api/status` | session | Server status (cached) |
| `GET /api/actions` | session | Catalogue filtered by role |
| `POST /api/actions` | session | Runs a built-in action |
| `POST /api/rcon` | `rcon:raw` | Raw console |
| `GET /api/audit` | `audit:read` | Last 50 audit entries |
| `GET /api/health` | public | Liveness (Docker probe) |
| `GET /api/ready` | public | Readiness: config + database + RCON |

## Security model

This panel assumes:

- **a single instance** (1 container = 1 Node process = 1 RCON connection). Rate limiters and the
  status cache live in process memory: behind a load balancer they would be bypassable;
- **restricted network access** — the panel is published on `127.0.0.1` by default; when served
  over HTTPS behind a reverse proxy, set `TRUST_PROXY=true` (otherwise `X-Forwarded-For` is
  ignored, which is deliberate: a forgeable header must not drive rate limiting);
- **the Factorio server's RCON port is only reachable by the panel** in production.

What is in place:

- sessions persisted in SQLite: signing out really **revokes** the cookie;
- constant-time password comparison, login attempt limiting (per IP when it is trustworthy, plus a
  global cap that is always active);
- per-session command rate limiting and a **bounded RCON queue** (503 beyond it);
- origin checking on every mutating request, `httpOnly`/`SameSite=Lax` cookie, `secure` set
  automatically over HTTPS;
- CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and HSTS headers;
- audit log of every action, refusals included.

Out of scope: the Lua command confirmation is an interface aid, not a protection — an `admin`
account has full RCON access by definition.
