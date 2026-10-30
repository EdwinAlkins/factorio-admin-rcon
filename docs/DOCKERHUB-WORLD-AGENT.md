<p align="center"><img src="https://edwinalkins.github.io/factorio-admin-rcon/assets/brand/logo-256.png" alt="" width="128" height="128"></p>

# Factorio world agent

**Generates worlds for [Factorio Admin RCON](https://hub.docker.com/r/williamnauroy/factorio-admin-rcon).**
It runs the game's own binary beside the server to draw terrain previews, compare seeds, build new
maps into a library, and read the presets, planets and resources the Worlds tab is built from —
mods included.

[Documentation](https://edwinalkins.github.io/factorio-admin-rcon/services.html) ·
[GitHub](https://github.com/EdwinAlkins/factorio-admin-rcon) ·
[Agent reference](https://github.com/EdwinAlkins/factorio-admin-rcon/blob/main/services/agents/README.md#world-agent)

> This image is not useful on its own: it answers the panel only. Start from the
> [full install](https://edwinalkins.github.io/factorio-admin-rcon/installation.html#full).

![Comparing four seeds before creating a world](https://edwinalkins.github.io/factorio-admin-rcon/assets/media/worlds-compare.png)

## Which Factorio is inside

This image is built on `factoriotools/factorio:stable` **as of the release**: the agent's binary
sits on top of the game. A preview from another game version may not match the map your server
would generate, so the Worlds tab warns when the two differ.

If your server runs another version, build the agent on the same image instead — the repository's
`docker-compose.yml` does it from `FACTORIO_IMAGE`:

```bash
docker build --build-arg AGENT=world-agent --target world-agent \
  --build-arg FACTORIO_IMAGE=factoriotools/factorio:<your server tag> \
  -t factorio-world-agent services/agents
```

## Confinement

The game image has a shell and a libc, so the confinement comes from how the agent runs it and
from Compose:

- **no command line from outside**: the game is started without a shell, with arguments the agent
  builds itself; no route takes a path, a command or a URL;
- **one run at a time**, under a deadline (`RUN_TIMEOUT_SECONDS`), 30 runs a minute;
- **the server's mods are read-only**, and it never sees the server's saves;
- **no Docker socket, no network out**, read-only root, no capability, uid 845.

## In the compose file

```yaml
  world-agent:
    image: williamnauroy/factorio-world-agent:<version>   # same version as the panel
    restart: unless-stopped
    user: "845:845"
    volumes:
      - ./data/mods:/factorio/mods:ro
      - ./worlds:/worlds               # owned by uid 845
    secrets:
      - world_agent_token
    environment:
      - WORLD_AGENT_TOKEN_FILE=/run/secrets/world_agent_token
    networks:
      - control                        # internal, shared with the panel only
    read_only: true
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=512m
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 1g                      # a 2048-tile preview peaks around 450 MB
```

| Variable | Default | |
| --- | --- | --- |
| `WORLD_AGENT_TOKEN_FILE` | — | Token file, shared with the panel. Required. |
| `RUN_TIMEOUT_SECONDS` | `180` | Bound on one run of the game, 10 to 1800. |
| `RUNS_PER_MINUTE` | `30` | Previews and new maps, all callers together. |
| `LOG_LEVEL` | `info` | |

## Tags

Released with the panel and versioned with it: `X.Y.Z`, `X.Y`, `X`, `latest`, for `linux/amd64` and
`linux/arm64`, with an SBOM and build provenance. Keep the panel and its agents on the same version:
they speak a private API.

MIT licensed. Source: <https://github.com/EdwinAlkins/factorio-admin-rcon>
