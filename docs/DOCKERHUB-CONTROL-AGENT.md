<p align="center"><img src="https://edwinalkins.github.io/factorio-admin-rcon/assets/brand/logo-256.png" alt="" width="128" height="128"></p>

# Factorio control agent

**The only component of [Factorio Admin RCON](https://hub.docker.com/r/williamnauroy/factorio-admin-rcon)
that holds the Docker socket.** It lets the admin panel start, stop and restart the Factorio
container, and read its state, CPU, memory and logs. Nothing else.

[Documentation](https://edwinalkins.github.io/factorio-admin-rcon/services.html) ·
[GitHub](https://github.com/EdwinAlkins/factorio-admin-rcon) ·
[Agent reference](https://github.com/EdwinAlkins/factorio-admin-rcon/blob/main/services/agents/README.md#control-agent)

> This image is not useful on its own: it answers the panel only. Start from the
> [full install](https://edwinalkins.github.io/factorio-admin-rcon/installation.html#full).

## Not a Docker proxy

A socket proxy filters Docker's own API, and whatever the filter lets through stays reachable.
This agent exposes its own API instead: a closed list of operations — status, stats, logs, start,
stop, restart — on **one** container, the one carrying this Compose project's `factorio` service
label. No route takes a container id, and its code has no path to exec, create, delete, images,
volumes or networks.

- **Allow-listed answers**: the container's environment, mounts, labels and network settings never
  leave the agent;
- **shared token**, read from a Compose secret, 32 characters minimum, compared in constant time;
- **one mutation at a time**, 10 a minute;
- **distroless static image**, non-root, read-only root, no capability, 32 MB.

What it does not change: whoever controls this process controls the socket, and the socket is root
on the host. Keep it unpublished and pinned.

## In the compose file

```yaml
  control-agent:
    image: williamnauroy/factorio-control-agent:<version>   # same version as the panel
    restart: unless-stopped
    user: "65532:65532"
    group_add:
      - "${DOCKER_GID}"          # stat -c %g /var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    secrets:
      - control_agent_token
    environment:
      - CONTROL_AGENT_TOKEN_FILE=/run/secrets/control_agent_token
      - TARGET_SERVICE=factorio
    networks:
      - control                  # internal, shared with the panel only
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

| Variable | Default | |
| --- | --- | --- |
| `CONTROL_AGENT_TOKEN_FILE` | — | Token file, shared with the panel. Required. |
| `TARGET_SERVICE` | `factorio` | Compose service of the Factorio container. |
| `STOP_TIMEOUT_SECONDS` | `60` | Grace before `SIGKILL` on stop and restart, 10 to 300. |
| `DOCKER_API_VERSION` | `1.43` | Docker 24+; `1.41` works from Docker 20.10. |
| `LOG_LEVEL` | `info` | |

## Tags

Released with the panel and versioned with it: `X.Y.Z`, `X.Y`, `X`, `latest`, for `linux/amd64` and
`linux/arm64`, with an SBOM and build provenance. Keep the panel and its agents on the same version:
they speak a private API.

MIT licensed. Source: <https://github.com/EdwinAlkins/factorio-admin-rcon>
