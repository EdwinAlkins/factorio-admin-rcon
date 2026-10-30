<p align="center"><img src="https://edwinalkins.github.io/factorio-admin-rcon/assets/brand/logo-256.png" alt="" width="128" height="128"></p>

# Factorio Admin RCON

**Not a server manager: a hardened RCON admin console.** Give moderators the server actions they
need without handing them full RCON.

![The panel: quick actions, RCON console and audit log](https://edwinalkins.github.io/factorio-admin-rcon/assets/media/demo.gif)

[Documentation](https://edwinalkins.github.io/factorio-admin-rcon/) ·
[GitHub](https://github.com/EdwinAlkins/factorio-admin-rcon) ·
[Security model](https://edwinalkins.github.io/factorio-admin-rcon/security.html)

- **Three roles** — viewer, moderator, administrator — enforced server-side: the action catalogue
  is filtered by role *and* execution re-checks the permission;
- **bounded actions**: the server builds the command from validated fields, so a moderator gets a
  "Kick" button without getting arbitrary Lua;
- **audit log** of every action, refusals included, in SQLite;
- **raw RCON console**, restricted to the administrator;
- **metrics** (CPU, memory, players, UPS) without mounting the Docker socket into the panel;
- **server control** — start, stop after a confirmed save, restart, logs — through a control agent
  that alone holds the Docker socket;
- **saves** — archives on demand or on a schedule, download, restore with a safety copy and
  automatic rollback — and **mods** from the official portal, dependencies resolved, applied with
  a single restart and rolled back on failure — through a data agent that alone holds the game's
  files;
- **English, French and Chinese**, inferred from the browser.

![Permission matrix: every role reads server state; only the administrator gets lifecycle controls, logs and raw RCON](https://edwinalkins.github.io/factorio-admin-rcon/assets/media/roles.png)

## Quick start

One directory, this `docker-compose.yml`, and a `.env` you generate. Nothing to clone. This is the
minimal stack: the game server and the panel, no agent, so no Server, Saves, Mods or Worlds tab. For every
feature, use the [full install](https://edwinalkins.github.io/factorio-admin-rcon/installation.html#full)
from the repository.

```yaml
services:
  factorio:
    container_name: factorio-server
    image: factoriotools/factorio:stable
    restart: unless-stopped
    ports:
      # Game port only. RCON stays unpublished: the panel reaches it over the
      # compose network, and the port hands full server control to whoever
      # holds the password.
      - "34197:34197/udp"
    volumes:
      - ./data:/factorio
    environment:
      # The image's own mod updater. It needs factorio.com credentials
      # (USERNAME and TOKEN): set them before turning it on.
      - UPDATE_MODS_ON_START=false

  factorio-admin:
    container_name: factorio-admin-panel
    # A minor tag: patches arrive, a major never lands on you by surprise.
    # In production, pin the exact version instead.
    image: williamnauroy/factorio-admin-rcon:1.5-distroless
    restart: unless-stopped
    depends_on:
      - factorio
    ports:
      # Loopback only: the panel grants full RCON access.
      - "127.0.0.1:3010:3000"
      - "[::1]:3010:3000"
    volumes:
      # The directory, not the file: a regenerated rconpw is picked up as is.
      - ./data/config:/factorio-config:ro
      # Sessions, audit log and metric series (SQLite).
      - factorio-admin-data:/data
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 256m
    pids_limit: 128
    environment:
      - RCON_HOST=factorio
      - RCON_PORT=27015
      - RCON_PASSWORD_FILE=/factorio-config/rconpw
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:?set it in .env}
      - SESSION_SECRET=${SESSION_SECRET:?set it in .env, 32 chars minimum}
      # No agents in this stack: no Server, Saves, Mods or Worlds tab, no CPU and
      # memory graphs. Players and UPS keep working.
      - CONTROL_ENABLED=false
      - METRICS_DOCKER=false
      - SAVES_ENABLED=false
      - MODS_ENABLED=false
      - WORLDS_ENABLED=false

volumes:
  factorio-admin-data:
```

Secrets are generated, not typed:

```bash
cat > .env <<EOF
ADMIN_PASSWORD=$(openssl rand -base64 18)
SESSION_SECRET=$(openssl rand -hex 32)
EOF

docker compose up -d
cat .env            # the password to log in with
                    # → http://127.0.0.1:3010
```

On the very first start the game server is still creating its map and `data/config/rconpw` does not
exist yet — the panel reports RCON as unavailable for a few seconds and recovers on its own,
without a restart.

## Essential configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | — | Required. Full access, including the raw RCON console |
| `SESSION_SECRET` | — | Required, 32 characters minimum. Signs the session cookie |
| `MODERATOR_PASSWORD` | — | Optional. Moderation actions, no raw RCON |
| `VIEWER_PASSWORD` | — | Optional. Read-only |
| `RCON_HOST` / `RCON_PORT` | `factorio` / `27015` | Where the Factorio server is |
| `RCON_PASSWORD_FILE` | `/factorio-config/rconpw` | Re-read on every connection attempt |
| `TRUST_PROXY` | `false` | Set to `true` **only** behind a reverse proxy you control |
| `METRICS_ENABLED` | `true` | `false` removes the feature end to end |
| `CONTROL_ENABLED` / `SAVES_ENABLED` / `MODS_ENABLED` / `WORLDS_ENABLED` | `true` | `false` removes the Server, Saves, Mods or Worlds tab — set them off without the agents |
| `CUSTOM_COMMANDS_FILE` | `/factorio-config/commands.json` | Your own bounded command catalogue |

The [full reference](https://edwinalkins.github.io/factorio-admin-rcon/configuration.html) covers
the rest.

## Tags

Every release publishes four tags for each variant: the exact version, the minor, the major, and
`latest`.

| Tag | What it is |
| --- | --- |
| `X.Y.Z`, `X.Y`, `X`, `latest` | Node 24 on Alpine |
| `X.Y.Z-distroless`, `X.Y-distroless`, `X-distroless`, `latest-distroless` | Same panel on `gcr.io/distroless/nodejs24-debian13` — no shell, no package manager |

Both run as uid 1000 and are volume-compatible, so switching either way keeps an existing
`factorio-admin-data` database. Pin an exact version in production.

**Platforms**: `linux/amd64` and `linux/arm64`. Every release ships an SBOM and build provenance.

## Security

The panel binds to `127.0.0.1` by default and expects an HTTPS reverse proxy to be exposed —
[recipes for Caddy, Nginx, Traefik and Tailscale](https://edwinalkins.github.io/factorio-admin-rcon/deployment.html).

What is in place: sessions persisted in SQLite so signing out really revokes the cookie,
constant-time password comparison, login attempt limiting, per-session command rate limiting and a
bounded RCON queue, origin checking on every mutating request, a nonce-based CSP, HSTS, a bounded
request body, and an audit log that fingerprints rather than stores raw console commands. The panel
holds **no Docker socket**: starting and stopping the server goes through a separate control agent
(`williamnauroy/factorio-control-agent`) with a closed, Factorio-only API. It holds **no game files**
either: saves and mods go through a data agent (`williamnauroy/factorio-data-agent`), which never
sees the socket, verifies every archive it writes, and alone reaches the Internet — only the
official mod portal. Worlds are generated by a world agent (`williamnauroy/factorio-world-agent`),
built on `factoriotools/factorio:stable`, with no socket and no network. The agents are published
with the panel; keep the four on the same version.

Be clear about the limit: the `admin` role has full RCON access by design, which means arbitrary
Lua. That is the account you protect, not one the panel can constrain.

Full detail: [security model](https://edwinalkins.github.io/factorio-admin-rcon/security.html) ·
[SECURITY.md](https://github.com/EdwinAlkins/factorio-admin-rcon/blob/main/SECURITY.md)

## Compatibility

Factorio 2.x including Space Age, any image exposing standard RCON, `amd64` and `arm64`, Docker
with the Compose v2 plugin. Not supported: Factorio before 2.0, non-standard RCON implementations,
and running more than one instance of the panel against the same server.

## Support

Bug reports and questions: [GitHub](https://github.com/EdwinAlkins/factorio-admin-rcon/issues).
Include the panel version, your Factorio version, the deployment type and the output of
`/api/ready`.

MIT licensed. Source: <https://github.com/EdwinAlkins/factorio-admin-rcon>
