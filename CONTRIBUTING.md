# Contributing

Issues and pull requests are welcome. This is a small project with one maintainer, so the shortest
path to a merged change is a focused diff with a reason attached.

## Before you start

For anything larger than a fix, open an issue or a discussion first. The panel has a deliberate
scope — it talks RCON to a server that is already running, and it does not manage mods, saves or
the server process. A pull request that crosses that line is likely to be declined, and it is
cheaper to find that out before you write it.

## Setting up

```bash
cp .env.example .env.local   # set ADMIN_PASSWORD at minimum
npm install
npm run dev                  # http://localhost:3000
```

You do not need a running Factorio server: the panel works, the status bar just shows the RCON
error. To develop against a real one, uncomment the loopback RCON mapping in `docker-compose.yml`.

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
```

All three run in CI, along with a build of both images and a check that every image tag named in the
documentation can actually be pulled from Docker Hub.

Tests live in three layers — pure logic in `tests/<domain>/`, route handlers called with a real
`Request` in `tests/api/`, and the things that must not regress in `tests/security/`. A change to
permissions, escaping, session handling or origin checking should arrive with a test in the last
one.

## Commit messages

`semantic-release` reads the commit prefix and it decides what gets published, so the prefix is not
a formality:

| Prefix | Effect |
| --- | --- |
| `fix: …`, `fix(deps): …` | Patch release, and a new image |
| `feat: …` | Minor release |
| `feat!: …` or a `BREAKING CHANGE:` footer | Major release |
| `chore: …`, `chore(deps-dev): …`, `docs: …`, `test: …`, `refactor: …` | No release |

Dependency updates follow the table in the [README](README.md#dependencies): a runtime dependency
is a `fix(deps):`, because a security fix has to reach deployments; tooling is a `chore(deps-dev):`.

## Translations

`messages/en.json` is the reference. The test suite checks that every dictionary exposes exactly
the same keys, that no catalogue action is missing a label, and that every message compiles as ICU —
so a translation that passes `npm test` is complete. Adding a language is four steps, listed in the
[README](README.md#languages).

No interface text belongs in `src/server/`: the API returns identifiers and error codes, and the
interface translates them.
