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

The Factorio server must be running (`docker compose up -d factorio`). RCON is **not published by
default** — in production the panel reaches it over the compose network, so nothing needs to be
exposed on the host. To develop against it, uncomment the loopback mapping in `docker-compose.yml`:

```yaml
- "127.0.0.1:27015:27015/tcp"
```

The RCON password is read from `../data/config/rconpw`, generated on first server start by
`docker/files/docker-entrypoint.sh`.

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

### Hardened image (optional)

`Dockerfile.distroless` builds the same application on `gcr.io/distroless/nodejs24-debian13`, which
ships Node and nothing else — `/bin`, `/usr/bin` and `/sbin` are empty. The default `Dockerfile` is
unchanged; this one is opt-in:

```bash
docker build -f Dockerfile.distroless -t factorio-admin-rcon:distroless .
```

Gone from the image: `sh`, `nc`, `wget`, `vi`, `cat`, `apk`, `npm`. The most valuable of those is
the shell — `child_process.exec()` spawns `/bin/sh -c`, so without it command injection has nothing
to run, and most off-the-shelf reverse shells stop working. Nothing legitimate depends on a shell
here: the codebase never uses `child_process`.

Be clear about the limit, though: **`node` is still the most capable binary in the image**. Anyone
able to execute JavaScript in the container can read files and open sockets through `fs` and `net`.
This raises the cost of post-exploitation, it does not remove it.

Both images run as uid 1000 and are volume-compatible, so switching either way keeps an existing
`factorio-admin-data` database. (That is why the distroless stage sets `USER 1000:1000` explicitly
instead of the base image's own `nonroot` user at 65532, which could not write to it.)

The trade-off is troubleshooting: there is no `docker exec … sh`. Attach a throwaway toolbox
sharing the container's namespaces instead:

```bash
docker run --rm -it \
  --pid=container:factorio-admin-panel \
  --network=container:factorio-admin-panel \
  nicolaka/netshoot
```

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
├── components/     interface (console, actions, audit, metrics, modal)
├── hooks/          server status (polling), command execution, translations
├── i18n/           routing, dictionary loading, locale-aware navigation
├── lib/            shared client/server code (types, permissions, typed fetch)
└── server/         server-only code
    ├── actions/    business definitions + execution
    ├── audit/      SQLite log
    ├── auth/       accounts, sessions, rate limiters
    ├── config/     validated environment variables (zod)
    ├── http/       route wrapper (session, permission, origin, logs)
    ├── metrics/    Docker client, sampler, time series
    └── rcon/       service, queue, parsing, status cache

messages/           dictionaries (en.json is the reference)
```

Two distinct execution paths:

- `POST /api/actions` — `{ action, values }`. The server validates the arguments, enforces the
  permission and **builds the command itself**. Used by every role.
- `POST /api/rcon` — raw command. Restricted to the `rcon:raw` permission (`admin` role).

## Metrics

The whole feature is optional. `METRICS_ENABLED=false` turns it off end to end — no collector, no
**Statistics** tab, and `GET /api/metrics` answers `404 metrics_disabled` — and the panel is exactly
what it was before the feature existed. Rows already collected are kept, so switching it back on
restores the history. Below the master switch sit one flag per source: `METRICS_DOCKER` (CPU and
memory) and `METRICS_UPS` (the Lua tick probe), both on by default and both ignored when the master
is off.

When metrics are disabled, **remove the `docker-proxy` service** from the compose file: it is the
only component that mounts the Docker socket, and running it for a switched-off feature keeps the
attack surface without the benefit.

The panel samples the server every `METRICS_INTERVAL_MS` (15 s by default) and stores the result
in the same SQLite file, keeping `METRICS_RETENTION_DAYS` (7 days ≈ 2 MB) and purging the rest at
startup and hourly. Four series are collected:

| Metric | Source |
| --- | --- |
| CPU %, memory | Docker API, through `docker-proxy` |
| Players online | RCON, via the existing status cache |
| UPS | RCON, tick delta between two samples (`/silent-command`) |

They are read in the **Statistics** tab, next to the console (charts: Recharts).

Each bucket carries `min`, `max`, `avg` **and the number of real measurements**. The first three
describe the distribution — the shaded band runs from min to max, which is what makes short spikes
visible where a plain average would smooth them away. The last one says how far the curve can be
trusted: a one-hour bucket built on a single reading draws exactly like a full one, so the band is
hidden below 50 % coverage rather than turning missing data into information.

Bounds are stored neutrally (`min`/`max`); only the UI knows that CPU cares about the maximum and
UPS about the minimum. `cycles` counts collector runs, not measurements — a run where both sources
are silent still writes its row, so each metric carries its own `samples`.

The x-axis always spans the **requested** range, so ten minutes of history on a 7-day view occupy a
tenth of the width rather than being stretched across it. `GET /api/metrics` also returns the
collector's own `health` (per-source `healthy` / `lastSuccessAt` / `consecutiveFailures`, plus
`storageFailures`), so the panel can tell "no data yet" from "the source is down" instead of
inferring it from the absence of points.

The sampler runs in the Node process (`src/server/metrics/collector.ts`, started from
`src/instrumentation.ts`) — there is no external scheduler to deploy.

## Endpoints

| Route | Auth | Role |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | — | Opens / revokes a session |
| `GET /api/status` | session | Server status (cached) |
| `GET /api/actions` | session | Catalogue filtered by role |
| `POST /api/actions` | session | Runs a built-in action |
| `POST /api/rcon` | `rcon:raw` | Raw console |
| `GET /api/audit` | `audit:read` | Last 50 audit entries |
| `GET /api/metrics` | `status:read` | Time series, `?range=1h\|6h\|24h\|7d` (404 when disabled) |
| `GET /api/health` | public | Liveness (Docker probe) |
| `GET /api/ready` | public | Readiness: config + database + RCON |

## Security model

This panel assumes:

- **a single instance** (1 container = 1 Node process = 1 RCON connection). Rate limiters and the
  status cache live in process memory: behind a load balancer they would be bypassable;
- **restricted network access** — the panel is published on `127.0.0.1` by default; when served
  over HTTPS behind a reverse proxy, set `TRUST_PROXY=true` (otherwise `X-Forwarded-For` is
  ignored, which is deliberate: a forgeable header must not drive rate limiting);
- **the Factorio server's RCON port is only reachable by the panel** in production — the compose
  file no longer publishes `27015` on the host, so RCON lives on the compose network alone. Publish
  it only if you drive RCON yourself, and bind it to loopback when you do: the protocol offers a
  single password, no rate limiting, and full server control to whoever gets through.

Both the panel and `docker-proxy` run confined in `docker-compose.yml`: `read_only` root filesystem,
`cap_drop: [ALL]`, `no-new-privileges`, plus memory and PID caps. The panel writes only to the
`/data` volume, so nothing needs a writable root; `docker-proxy` needs a tmpfs on `/run` because
haproxy puts its pidfile there.

The `factorio` service is deliberately left alone — it writes saves, mods and config to
`/factorio`, so a read-only root would break it. If you want the memory graph to show a real
ceiling rather than the host's RAM, give *that* service a `mem_limit` sized for your map: the graph
plots the Factorio container, so a limit on the panel changes nothing there.

What is in place:

- sessions persisted in SQLite: signing out really **revokes** the cookie;
- constant-time password comparison, login attempt limiting (per IP when it is trustworthy, plus a
  global cap that is always active);
- per-session command rate limiting and a **bounded RCON queue** (503 beyond it);
- origin checking on every mutating request, `httpOnly`/`SameSite=Lax` cookie, `secure` set
  automatically over HTTPS;
- CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and HSTS headers;
- audit log of every action, refusals included;
- **no Docker socket in the panel**. CPU and memory metrics go through the `docker-proxy`
  service, which holds the socket and exposes only `GET /containers/...` (`CONTAINERS=1`,
  `POST=0`). Mounting the socket into the panel itself would hand an attacker who compromised it
  the whole host — `:ro` on the mount changes nothing, since the Docker API is a write API. The
  proxy is not published on any port and is reachable only from the compose network. Removing it
  (and setting `METRICS_ENABLED=false`) only costs the CPU/memory graphs; players and UPS keep
  working.

Out of scope: the Lua command confirmation is an interface aid, not a protection — an `admin`
account has full RCON access by definition.
