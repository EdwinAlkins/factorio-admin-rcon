# Agents

The privileged half of the stack, as small Go services the panel talks to over a private network.
One module, one binary and one image per agent:

| Agent | Holds | Never holds |
| --- | --- | --- |
| `cmd/control-agent` | the Docker socket | the game's files |
| `cmd/data-agent` | the game's saves and mods, the panel's archives, the way to the mod portal | the Docker socket, the game's binary |
| `cmd/world-agent` | the game's binary, the library of generated worlds | the Docker socket, the server's saves, the network |

The split is enforced, not just described: `boundaries_test.go` fails if a binary links another's
packages, or if the shared kit (`internal/agentkit`: token check, logging, mutation guard, strict
JSON) links any of them.

```bash
docker build --build-arg AGENT=control-agent -t factorio-control-agent .
docker build --build-arg AGENT=data-agent    -t factorio-data-agent .
docker build --build-arg AGENT=world-agent --target world-agent -t factorio-world-agent .
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
streams them for download and restores them, and installs, updates, enables and removes mods. It
never sees the Docker socket: stopping the server around a restore or a mod change is the panel's
job, through the control agent.

It is also the only component that reaches the Internet, and only the official mod portal
(`mods.factorio.com` and its download host, `dl-mod.factorio.com`), over HTTPS. No route takes a
URL: requests are built from that fixed base and validated mod names, and every redirect is
checked against the two hosts. In Compose it is alone on the `egress` network; the panel and the
control agent keep no route out.

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
| `POST /v1/uploads` `{size, name}` | Opens an upload of a save from the operator's computer. `201` with its `id` and `chunkBytes`. One at a time. |
| `GET /v1/uploads/{id}` | Where an upload stands (`offset`, `size`). |
| `PUT /v1/uploads/{id}?offset=` | One chunk (raw bytes, at most `chunkBytes`), which must start at the current offset. |
| `POST /v1/uploads/{id}/complete` `{label?, createdBy?}` | Verifies the whole file as a save and publishes it as an archive of source `upload`. `201` with its sidecar. |
| `DELETE /v1/uploads/{id}` | Abandons an upload and deletes what it received. |

Server settings, when `CONFIG_DIR` is mounted (otherwise `404 server_settings_unavailable`):

| Route | Answer |
| --- | --- |
| `GET /v1/server-settings` | The editable keys of `server-settings.json`, `secrets` (whether each of `game_password`, `token`, `password` is set — never a value) and the file's `hash`. |
| `PUT /v1/server-settings` `{settings, secrets, hash}` | Changes the keys named, in place, keeping every other member in its order. `secrets` take `{set}` or `{clear: true}`. Refused if the file changed since `hash`. Answers the new view and `tx`, the id of the previous version. |
| `POST /v1/server-settings/rollback` `{tx}` | Puts that previous version back. |

Worlds, when `WORLDS_DIR` (the world agent's library) is mounted, read-only (otherwise
`404 worlds_unavailable`):

| Route | Answer |
| --- | --- |
| `POST /v1/worlds/{id}/archive` `{createdBy?}` | Copies the world into the archives, source `world`, verified as a save and against the checksum the world agent recorded. `201` with its sidecar. Putting it in play is then an ordinary restore. |

Mods, with `factorioVersion` (`2.1.23`, which the panel reads through RCON) wherever releases are
chosen:

| Route | Answer |
| --- | --- |
| `GET /v1/mods?factorioVersion=` | Installed mods (`builtin`, `unpacked`, `dlc`) and, with a version, the update each one has on the portal. |
| `GET /v1/mods/search?q=&page=&factorioVersion=` | Portal search. Needs credentials. |
| `GET /v1/mods/portal/{name}?factorioVersion=` | A mod's releases and dependencies. |
| `POST /v1/mods/plan` `{changes, factorioVersion}` | What a basket would do: steps, dependencies, conflicts, `hash`. Writes nothing. |
| `POST /v1/mods/stage` `{changes, factorioVersion, planHash}` | Recomputes the plan, refuses it if its hash differs, downloads and verifies every archive into a new transaction. `201` with `tx`. The mods folder is not touched. |
| `POST /v1/mods/commit` `{tx}` | Swaps a staged transaction into the mods folder. The server must be stopped. |
| `POST /v1/mods/rollback` `{tx}` | Undoes a commit from its journal. Harmless on one never committed. |

Searches, mod pages and plans share a budget of 60 portal calls per minute; stage, commit and
rollback sit under the mutation guard. Upload chunks do not — a 2 GB save is 256 of them — but
have their own budget of 600 per minute, and are written one at a time.

Errors use the same format as the control agent's, with `backup_not_found` (404), `no_save` (409),
`invalid_archive` and `checksum_mismatch` (422), `io_error` (500), `busy` (409) and `rate_limited`
(429). For worlds: `world_not_found` and `worlds_unavailable` (404). For uploads: `upload_busy`, `upload_offset` (the chunk does not start where the upload
stands: ask, then resume) and `upload_incomplete` (409); `upload_not_found` and `uploads_disabled`
(404); `upload_too_large` and `chunk_too_large` (413). For server settings: `invalid_setting`
(400), `server_settings_missing` and `settings_tx_not_found` (404), `settings_changed` (409),
`server_settings_unreadable` and `public_needs_credentials` (422). For mods: `mods_conflict`, `plan_changed`, `mods_nothing_to_do`, `mods_unavailable` (no
mods folder yet), `tx_already_committed` and `portal_credentials_missing` (409); `mod_not_found` and
`tx_not_found` (404); `invalid_mod_archive`, `download_checksum` and `download_too_large` (422);
`portal_unreachable` and `portal_rejected` (502).

## Archives

An archive is `<id>.zip` plus `<id>.json` in the backups folder. The id is generated by the agent
(`20261027-143000-manual`); no route takes a path. The sidecar records the source (`manual`,
`scheduled`, `pre-restore`, `pre-mods`, `upload`, `world`), who asked, the save it was taken from, its size and
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

**Uploads** land in `.uploads/` inside the backups folder, out of every listing and on the same
filesystem as the archives, so publishing one is a rename once it has been verified like any
copy. Their state lives in memory: an upload the agent was restarted during is dropped, and one
left alone for 15 minutes no longer blocks the next. An uploaded archive records neither the game
version nor the mod set — nothing in a save states them in a stable form.

The restored file is written last, with the current time, so `--start-server-load-latest`
(factoriotools' default, `LOAD_LATEST_SAVE=true`) loads it. For a server started on a fixed
`SAVE_NAME`, set `TARGET_SAVE_NAME` to that file name.

## Mods

The mod set is `mod-list.json` plus the archives and folders next to it. A mod listed without
either ships with the game (`base`, `recycler`, the expansion's): it can be disabled, never
removed. `elevated-rails`, `quality` and `space-age` are flagged `dlc`: the factoriotools image
enables or disables them from `DLC_SPACE_AGE` at every start, so the planner refuses to toggle
them. A mod installed as a folder is listed and can be toggled, never replaced or removed.

- **The plan** resolves `info.json` dependencies (`!`, `?`, `(?)`, `~`, `< <= = >= >`) greedily
  and explicitly: the newest release for the game's major.minor that satisfies every enabled mod's
  constraints, then its required dependencies, recursively. What cannot be satisfied is a
  conflict for the operator — never a silent downgrade elsewhere. Its `hash` covers the steps, so
  a release published between preview and apply is caught.
- **Staging** downloads each archive with the player's credentials, bounded by
  `MODS_MAX_DOWNLOAD_MB`, and checks it before keeping it: the portal's SHA-1, every entry's CRC,
  names that stay inside the archive, a single top folder `{name}_{version}/` or `{name}/`, and an
  `info.json` declaring that same name and version.
- **Commit** works from a journal written before each move: `mod-list.json` and every archive
  replaced or removed are first copied into the transaction, then the new archives are copied in
  (atomically, re-verified) and `mod-list.json` rewritten — keeping, in order, every entry and
  field it does not change. **Rollback** replays the journal backwards, even after a crash halfway.
- **Transactions** live in `.mods/<tx>/` inside the backups folder, out of Factorio's sight; the
  three latest are kept.
- **The token** travels only in the download URL's query string, as the portal requires; it is
  stripped from every error before anything can log it, and never appears in an answer.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATA_AGENT_TOKEN_FILE` | — | Token file. `DATA_AGENT_TOKEN` takes it inline (tests). Required. |
| `SAVES_DIR` | `/factorio/saves` | Factorio's saves folder. |
| `MODS_DIR` | `/factorio/mods` | The mods folder; read and written per request, so it may appear after the agent starts (the server creates it on its first run). |
| `CONFIG_DIR` | `/factorio/config` | Factorio's config folder, for `server-settings.json` only. Optional: missing or not writable turns server settings off, not the agent. |
| `BACKUPS_DIR` | `/backups` | Archives. Must be writable by the agent's uid (845), checked at startup. |
| `WORLDS_DIR` | `/worlds` | The world agent's library, read-only. Optional: missing turns world activation off, not the agent. |
| `TARGET_SAVE_NAME` | — | Save name a restore writes, for a fixed `SAVE_NAME`. |
| `PORTAL_CREDENTIALS_FILE` | — | JSON `{"username", "token"}` from factorio.com. Missing, empty or `{}`: no search, no install. |
| `MODS_MAX_DOWNLOAD_MB` | `200` | Bound on one mod download. |
| `SAVES_MAX_UPLOAD_MB` | `2048` | Bound on a save uploaded from the operator's computer. |
| `MUTATIONS_PER_MINUTE` | `30` | |
| `LISTEN_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | |

# World agent

Generates Factorio worlds beside the running server: terrain previews, new maps, and the catalogue
the panel's form is built from. It runs the game's own binary, from the image it is built on —
the server's (`FACTORIO_IMAGE`), so worlds come from the version the server runs. It holds neither
the Docker socket nor the server's saves: it writes its library and a private work folder, and
reads the server's mods. Putting a world in play is the data agent's job (it archives the world,
then the panel restores it like any archive).

## API

All routes except `/healthz` require `Authorization: Bearer <token>` — a token distinct from the
other agents'.

| Route | Answer |
| --- | --- |
| `GET /v1/catalog` | `factorioVersion`; `planets` (each with its autoplace controls, its resources and whether it has climate controls); `controls` (category, order, richness, can be disabled); the game's `presets`, named values turned into numbers; the game's default `mapSettings`. Read with `--dump-data` and the server's mods, cached until the mods change. |
| `POST /v1/previews` `{settings, seed?, size, planet, offset, report}` | Renders a preview (`--generate-map-preview`). `size` is 256, 512, 1024 or 2048; `report` names up to 16 resource entities to count (`--report-quantities`). Without a seed, one is drawn — or, with an exchange string, the string's own is kept. Answers its `id`, the `seed` used and the `quantities`. |
| `GET /v1/previews/{id}` | The image (PNG). The latest 16 (64 MB at most) are kept in memory. |
| `GET /v1/worlds` | Every world with its sidecar, newest first, and the agent's `factorioVersion`. |
| `POST /v1/worlds` `{name, settings, seed?, createdBy?}` | Generates a map (`--create`) with a 1024 px preview. `201` with its sidecar. |
| `GET /v1/worlds/{id}/preview` | A world's preview. |
| `GET /v1/worlds/{id}/download` | Its save, with `Range` support and `X-Content-SHA256`. |
| `DELETE /v1/worlds/{id}` | Removes it. |

`settings` holds `mapGen` (map-gen-settings.json: `width`, `height`, `starting_area`,
`peaceful_mode`, `no_enemies_mode`, `autoplace_controls`, `cliff_settings`,
`property_expression_names`), `mapSettings` (map-settings.json: `difficulty_settings`,
`pollution`, `enemy_evolution`, `enemy_expansion`), or `exchangeString` alone (`>>>…<<<`). Every
member is optional, keeps Factorio's own name, and is range-checked; an unknown one is refused.

Errors use the same format, with `factorio_refused` (422: the game's own first error line, e.g.
`"nope" is not a valid autoplace control name.`, passed on in `error`), `factorio_timeout` (504),
`invalid_world_settings` and `bad_body` (400), `world_not_found` and `preview_not_found` (404),
`busy` (409: the game is already running), `rate_limited` (429) and `io_error` (500).

## Running the game

- **No command line from outside**: the binary is started through `exec`, never a shell, with the
  options the agent chooses — `--generate-map-preview`, `--create`, `--dump-data`, `--version` —
  numbers, file names of its own, and prototype names that passed a strict pattern. Settings are
  decoded into fixed structures and written back out by the agent; an exchange string must match
  `>>>[A-Za-z0-9+/=\s]+<<<` and stay under 64 KB.
- **map-settings.json is always complete**: the game refuses one with a member missing, so the
  operator's values are laid over the game's own `map-settings.example.json`.
- **One run at a time**, refused with `409` rather than queued, bounded by `RUN_TIMEOUT_SECONDS`
  and killed past it. Previews and new maps share a budget of `RUNS_PER_MINUTE`.
- **The mods folder is read-only**: each run sees it through a folder of links in the work
  folder, with private copies of `mod-list.json` and `mod-settings.dat`, which the game rewrites at
  every start.
- **The game's write-data is the work folder** (`config.ini`, written at startup): nothing is
  written to the image. The data dump (~30 MB) is deleted once read.
- **The mod set** a world records is the one the game loaded, read from its own log; the mods
  that ship with the game carry no version, as in the data agent's mod set.
- **A new map is published like an archive**: copied atomically into the library, its checksum
  recorded, the sidecar written last. The data agent checks that checksum again when it archives
  the world.

**Container**: the server's image (Debian with the game), not distroless: it has a shell. Compose
runs it as uid 845 with a read-only root, a tmpfs for the work folder, no capability,
`no-new-privileges`, 1 GiB (a 2048 px preview peaks around 450 MB) and 256 PIDs (the game's
threads count). It is alone with the panel on the `control` network: no route out.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `WORLD_AGENT_TOKEN_FILE` | — | Token file. `WORLD_AGENT_TOKEN` takes it inline (tests). Required. |
| `WORLDS_DIR` | `/worlds` | The library. Must be writable by the agent's uid (845), checked at startup. |
| `MODS_DIR` | `/factorio/mods` | The server's mods, read-only. Missing: the game's own mods only. |
| `FACTORIO_BINARY` | `/opt/factorio/bin/x64/factorio` | |
| `FACTORIO_DATA_DIR` | `/opt/factorio/data` | For `map-settings.example.json`. |
| `WORK_DIR` | `/tmp/world-agent` | Private, writable: the game's write-data, settings files, outputs. |
| `RUN_TIMEOUT_SECONDS` | `180` | Bound on one run of the game, 10 to 1800. |
| `RUNS_PER_MINUTE` | `30` | Previews and new maps, all callers together. |
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
archives built by `internal/fakesave`. The world agent's runner tests start the real `exec` path
against the test binary itself, which answers as a fake Factorio (`FAKE_FACTORIO=1`), with a data
dump trimmed from the real game's in `internal/factorio/testdata`.
