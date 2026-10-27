# Agents

The privileged half of the stack, as small Go services the panel talks to over a private network.
One module, one binary and one image per agent:

| Agent | Holds | Never holds |
| --- | --- | --- |
| `cmd/control-agent` | the Docker socket | the game's files |
| `cmd/data-agent` (phase 3) | the game's saves and mods | the Docker socket |

The split is enforced, not just described: `boundaries_test.go` fails if either binary links the
other's packages, or if the shared kit (`internal/agentkit`: token check, logging, mutation guard,
strict JSON) links either.

```bash
docker build --build-arg AGENT=control-agent -t factorio-control-agent .
```

# Control agent

The only component of the stack that mounts the Docker socket. It lets the admin panel start, stop
and restart the Factorio container, read its state, CPU/memory and logs — and nothing else.

It is not a Docker proxy. A proxy filters Docker's own API, and everything the filter lets through
(for `tecnativa/docker-socket-proxy` with `CONTAINERS=1`: every container's inspect, environment
included) is reachable. This agent exposes its own API instead, a closed list of operations on
**one** container, and the Docker calls behind them are the only ones its code can make.

## API

All routes except `/healthz` require `Authorization: Bearer <token>`.

| Route | Answer |
| --- | --- |
| `GET /healthz` | `{"ok":true}`. No token, no Docker call: the container's own healthcheck. |
| `GET /v1/server/status` | `state`, `health`, `startedAt`, `finishedAt`, `exitCode`, `restartCount`, `image`. Nothing else from the inspect. |
| `GET /v1/server/stats` | `cpu_stats`, `precpu_stats`, `memory_stats` (the fields the panel's graphs use). |
| `GET /v1/server/logs?tail=1..1000&since=<unix>` | Demultiplexed lines, `{stream, text}`, 4 KiB per line, 2 MiB per answer. |
| `POST /v1/server/start` | `{changed, container}` — `changed: false` when it was already running. |
| `POST /v1/server/stop` | Optional body `{"timeoutSeconds": 10..300}`: grace before `SIGKILL`. |
| `POST /v1/server/restart` | Same body as stop. |

Anything else — another path, another method, `/containers/...`, `/exec` — is a `404` and never
reaches the daemon. Errors are `{"ok":false,"code":"…","error":"…"}` with `unauthorized`,
`not_found`, `bad_query`, `bad_body`, `busy` (409), `rate_limited` (429), `target_missing` /
`target_ambiguous` (503), `docker_error` (502) or `docker_timeout` (504).

## Target

The container is the one carrying `com.docker.compose.service=$TARGET_SERVICE` **and**
`com.docker.compose.project=<project>`. The project is `TARGET_PROJECT` when set, otherwise read at
startup from the agent's own container labels — so a second stack on the same host with its own
`factorio` service is never matched. Exactly one container must match: zero or several is a `503`,
never a guess. Mutations resolve the target afresh; reads may reuse it for 10 s.

## Protections

- **Closed surface**: the Docker client implements list, inspect, stats, logs, start, stop and
  restart. There is no code path to exec, create, delete, images, volumes or networks.
- **Allow-listed answers**: inspect and stats are decoded into fixed structs; container
  environment, mounts, labels and network settings are dropped by the decoder.
- **Shared token**, read from a file (a Compose secret, so it does not show up in `docker inspect`),
  32 characters minimum, compared in constant time.
- **Strict bodies**: 1 KiB, unknown members, duplicate keys and invalid UTF-8 refused
  (`encoding/json/v2`).
- **One mutation at a time** (`409 busy`, not queued) and **10 mutations a minute** across all
  callers (`MUTATIONS_PER_MINUTE`).
- **Network**: unpublished, on an `internal` Compose network shared with the panel only. The game
  server is not on it and cannot resolve the agent's name.
- **Container**: distroless static image, non-root uid 65532 plus the socket's group
  (`group_add: DOCKER_GID`), read-only root, no capability, `no-new-privileges`, 32 MiB, 32 PIDs.

**What it does not change**: whoever controls this process controls the socket, and the socket is
root on the host. The agent shrinks what the *panel* can make it do; it does not make the socket
harmless. Keep it unpublished, keep its image pinned, and rebuild it on Go security releases.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CONTROL_AGENT_TOKEN_FILE` | — | Token file. `CONTROL_AGENT_TOKEN` takes it inline (tests). Required. |
| `TARGET_SERVICE` | `factorio` | Compose service of the Factorio container. |
| `TARGET_PROJECT` | own project | Compose project; leave empty to use the agent's own. |
| `STOP_TIMEOUT_SECONDS` | `60` | Default grace period for stop/restart, 10 to 300. |
| `MUTATIONS_PER_MINUTE` | `10` | |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | |
| `DOCKER_API_VERSION` | `1.43` | Pinned rather than negotiated. The default needs Docker 24+; `1.41` works from Docker 20.10. |
| `LISTEN_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | JSON logs on stdout; probes at `debug`. |

## Development

Go 1.27, standard library only, for the whole module.

```bash
go vet ./... && go test -race ./...
# Built with the module's toolchain: a linter compiled with an older Go
# refuses to load go.mod's language version.
GOTOOLCHAIN=go1.27.3 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
GOTOOLCHAIN=go1.27.3 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0 run ./...
```

The tests run the real client against a fake daemon on a Unix socket (`internal/fakedocker`), which
records every request: they assert as much on what never reached the daemon as on what did.
