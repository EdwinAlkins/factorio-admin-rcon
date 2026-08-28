# Getting help

| What you have | Where it goes |
| --- | --- |
| Something is broken | [Open an issue](https://github.com/EdwinAlkins/factorio-admin-rcon/issues/new/choose) |
| A question about using it | [Discussions](https://github.com/EdwinAlkins/factorio-admin-rcon/discussions) |
| An idea or a feature request | [Discussions](https://github.com/EdwinAlkins/factorio-admin-rcon/discussions) — issues are for defects |
| A security vulnerability | [SECURITY.md](SECURITY.md) — **not** a public issue |
| A change you have already written | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before opening an issue

Most reports that stall do so for want of one of these. Five minutes here saves a round trip:

1. **Check the [FAQ](README.md#faq)** — mods, saves, starting the server and individual accounts
   are all deliberate non-features, and they account for most of the surprises.
2. **Check [compatibility](README.md#compatibility)** — Factorio 2.x, standard RCON, one panel
   instance per server.
3. **Get `/api/ready`.** It reports config, command catalogue, database and RCON separately, which
   usually names the broken one outright:
   ```bash
   curl -s http://127.0.0.1:3010/api/ready
   ```
4. **Get the logs.** `docker compose logs factorio-admin` for the panel,
   `docker compose logs factorio` when RCON is the suspect.

## What to include

- the **panel version** (the image tag, or `git rev-parse --short HEAD`);
- the **image variant**: standard or `-distroless`;
- your **Factorio version** and server image;
- the **deployment**: plain Docker Compose, behind Caddy/Nginx/Traefik, Tailscale, from source;
- the output of **`/api/ready`**;
- the **panel logs** around the failure;
- what you expected, and what happened instead.

Redact passwords, `SESSION_SECRET` and the RCON password before pasting logs or a compose file.

## Response times

One maintainer, best effort, no SLA. Security reports are the exception and are handled first — see
[SECURITY.md](SECURITY.md).
