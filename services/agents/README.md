# Agents

The privileged half of the stack, as small Go services the panel talks to over a private network.
One module, one binary and one image per agent:

| Agent | Holds | Never holds |
| --- | --- | --- |
| `cmd/control-agent` | the Docker socket | the game's files |
| `cmd/data-agent` | the game's saves and the panel's archives | the Docker socket |

The split is enforced, not just described: `boundaries_test.go` fails if either binary links the
other's packages, or if the shared kit (`internal/agentkit`: token check, logging, mutation guard,
strict JSON) links either.

```bash
docker build --build-arg AGENT=control-agent -t factorio-control-agent .
docker build --build-arg AGENT=data-agent    -t factorio-data-agent .
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

# Data agent

The only component of the stack that writes the game's files. It archives saves, verifies them,
streams them for download and restores them. It never sees the Docker socket: stopping the server
around a restore is the panel's job, through the control agent.

## API

All routes except `/healthz` require `Authorization: Bearer <token>` — a token distinct from the
control agent's.

| Route | Answer |
| --- | --- |
| `GET /v1/saves` | The saves folder (name, size, mtime, which one loads next) and the current mod set. |
| `GET /v1/backups` | Every archive with its sidecar, newest first. |
| `POST /v1/backups` `{source, label?, createdBy?, factorioVersion?}` | Archives the newest save. `201` with its sidecar. |
| `GET /v1/backups/{id}/download` | The archive, with `Range` support and `X-Content-SHA256`. |
| `GET /v1/backups/{id}/verify` | Checksum and full read of the archive, without touching anything. |
| `POST /v1/backups/{id}/restore` | Makes the archive the only save; the previous ones are set aside. |
| `DELETE /v1/backups/{id}` | Removes the archive and its sidecar. |
| `POST /v1/backups/prune` `{sources, keepLast, maxAgeDays}` | Applies a retention policy. |

Errors use the same format as the control agent's, with `backup_not_found` (404), `no_save` (409),
`invalid_archive` and `checksum_mismatch` (422), `io_error` (500), `busy` (409) and `rate_limited`
(429).

## Archives

An archive is `<id>.zip` plus `<id>.json` in the backups folder. The id is generated by the agent
(`20261027-143000-manual`); no route takes a path. The sidecar records the source (`manual`,
`scheduled`, `pre-restore`, `pre-mods`), who asked, the save it was taken from, its size and
SHA-256, the Factorio version and the mod set. An archive is self-describing: the panel's
database is not needed to know what it is.

- **Copies are atomic**: written under a temporary name, synced, verified, then renamed. A crash
  leaves no partial archive.
- **Every copy is verified**: the zip must parse, every entry must decompress with a matching CRC,
  names must stay relative, and the level data must be there. An autosave copied while Factorio
  was writing it fails the check, and the copy is retried.
- **A restore re-checks the archive** against its recorded SHA-256, then verifies it again, before
  touching the saves folder. An altered or corrupted archive is never restored. The panel calls
  `verify` before stopping the server too, so a damaged archive disconnects no one.
- **A restore destroys nothing**: the saves it replaces are moved to `replaced-<time>/` in the
  backups folder (the three latest sets are kept), out of the saves folder so Factorio cannot
  load one of them instead.
- **Safety copies** (`pre-restore`, `pre-mods`) are never pruned before they are a week old.
- **Every path goes through `os.Root`**: `..`, absolute paths and symbolic links pointing outside
  the saves or backups folder are refused by the standard library.

The restored file is written last, with the current time, so `--start-server-load-latest`
(factoriotools' default, `LOAD_LATEST_SAVE=true`) loads it. For a server started on a fixed
`SAVE_NAME`, set `TARGET_SAVE_NAME` to that file name.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATA_AGENT_TOKEN_FILE` | — | Token file. `DATA_AGENT_TOKEN` takes it inline (tests). Required. |
| `SAVES_DIR` | `/factorio/saves` | Factorio's saves folder. |
| `MODS_DIR` | `/factorio/mods` | Read for the mod set an archive records; optional. |
| `BACKUPS_DIR` | `/backups` | Archives. Must be writable by the agent's uid (845), checked at startup. |
| `TARGET_SAVE_NAME` | — | Save name a restore writes, for a fixed `SAVE_NAME`. |
| `MUTATIONS_PER_MINUTE` | `30` | |
| `LISTEN_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | |

## Development

Go 1.27, standard library only, for the whole module.

```bash
go vet ./... && go test -race ./...
# Built with the module's toolchain: a linter compiled with an older Go
# refuses to load go.mod's language version.
GOTOOLCHAIN=go1.27.3 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
GOTOOLCHAIN=go1.27.3 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0 run ./...
```

The control agent's tests run the real client against a fake daemon on a Unix socket
(`internal/fakedocker`), which records every request: they assert as much on what never reached
the daemon as on what did. The data agent's run against temporary folders, with valid and broken
archives built by `internal/fakesave`.
