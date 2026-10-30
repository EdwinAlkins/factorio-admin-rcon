<p align="center"><img src="https://edwinalkins.github.io/factorio-admin-rcon/assets/brand/logo-256.png" alt="" width="128" height="128"></p>

# Factorio data agent

**The only component of [Factorio Admin RCON](https://hub.docker.com/r/williamnauroy/factorio-admin-rcon)
that writes the game's files.** It archives saves, verifies them, streams them for download and
restores them; installs, updates, enables and removes mods from the official portal; and edits
`server-settings.json`.

[Documentation](https://edwinalkins.github.io/factorio-admin-rcon/services.html) ·
[GitHub](https://github.com/EdwinAlkins/factorio-admin-rcon) ·
[Agent reference](https://github.com/EdwinAlkins/factorio-admin-rcon/blob/main/services/agents/README.md#data-agent)

> This image is not useful on its own: it answers the panel only. Start from the
> [full install](https://edwinalkins.github.io/factorio-admin-rcon/installation.html#full).

## What it guarantees

- **Every copy is verified**: the zip must parse and every entry decompress with a matching CRC,
  before anything is published;
- **a restore destroys nothing**: it re-checks the archive's SHA-256 first, and the saves it
  replaces are set aside, not deleted;
- **mods are staged before the server stops**: each download is checked against the portal's
  SHA-1, then swapped in from a journal, so a crash mid-way is undone;
- **every path goes through `os.Root`**: `..`, absolute paths and symbolic links pointing out are
  refused.

It never sees the Docker socket — stopping the server goes through the
[control agent](https://hub.docker.com/r/williamnauroy/factorio-control-agent). It is the only part
of the stack that reaches the Internet, and only `mods.factorio.com` and its download host: no
request carries a URL, and redirects are checked against those two hosts.

## In the compose file

```yaml
  data-agent:
    image: williamnauroy/factorio-data-agent:<version>   # same version as the panel
    restart: unless-stopped
    user: "845:845"                    # factoriotools' uid: files keep their owner
    volumes:
      - ./data/saves:/factorio/saves
      - ./data/mods:/factorio/mods
      - ./data/config:/factorio/config # server-settings.json only
      - ./backups:/backups             # owned by uid 845
      - ./worlds:/worlds:ro            # the world agent's library
    secrets:
      - data_agent_token
      - factorio_portal
    environment:
      - DATA_AGENT_TOKEN_FILE=/run/secrets/data_agent_token
      - PORTAL_CREDENTIALS_FILE=/run/secrets/factorio_portal
    networks:
      - control                        # internal, shared with the panel
      - egress                         # the mod portal, alone on it
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

| Variable | Default | |
| --- | --- | --- |
| `DATA_AGENT_TOKEN_FILE` | — | Token file, shared with the panel. Required. |
| `PORTAL_CREDENTIALS_FILE` | — | `{"username", "token"}` from factorio.com. Without it: no search, no install. |
| `MODS_MAX_DOWNLOAD_MB` | `200` | Bound on one mod download. |
| `SAVES_MAX_UPLOAD_MB` | `2048` | Bound on a save uploaded from the browser. |
| `TARGET_SAVE_NAME` | — | Save name a restore writes, for a server with a fixed `SAVE_NAME`. |
| `LOG_LEVEL` | `info` | |

## Tags

Released with the panel and versioned with it: `X.Y.Z`, `X.Y`, `X`, `latest`, for `linux/amd64` and
`linux/arm64`, on a distroless static base, with an SBOM and build provenance. Keep the panel and
its agents on the same version: they speak a private API.

MIT licensed. Source: <https://github.com/EdwinAlkins/factorio-admin-rcon>
