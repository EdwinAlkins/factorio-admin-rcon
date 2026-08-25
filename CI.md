# Continuous integration and publishing

CI does two things: it **checks** every pull request, and on `main` it **decides the version**,
creates the GitHub release, then publishes the image to Docker Hub.

Published image: [`williamnauroy/factorio-admin-rcon`](https://hub.docker.com/r/williamnauroy/factorio-admin-rcon)

> The Docker Hub namespace (`williamnauroy`) is not the GitHub account (`EdwinAlkins`). That is
> intentional, but it is the most likely source of error when a push is refused.

## The flow at a glance

```
Pull request ─────────► ci.yml
                        ├─ quality : npm ci · lint · typecheck · test
                        └─ image   : docker build (amd64, no push)

Push to main ─────────► release.yml
                        │
                        ├─ 1. ci ......... calls ci.yml (same checks)
                        │                   ↓ failure = nothing is published
                        ├─ 2. release .... semantic-release reads the commits
                        │                   → version, CHANGELOG.md, Git tag,
                        │                     GitHub release
                        │                   ↓ no relevant commit = we stop here
                        └─ 3. publish .... docker build amd64+arm64 → Docker Hub

Run workflow ─────────► release.yml (recovery: 1 and 2 skipped)
  (version entered)     └─ 3. publish .... rebuild of tag vN.N.N → Docker Hub
```

## Files

| File | Role |
| --- | --- |
| `.github/workflows/ci.yml` | Quality checks + validation build. Triggered on PRs, and called by `release.yml`. |
| `.github/workflows/release.yml` | Versioning, GitHub release, Docker Hub push. Triggered on `main` (and `beta`). |
| `.releaserc.json` | semantic-release configuration: branches and plugins. |

## How the version is computed

The version number is **never entered by hand**: it is derived from the commit messages since the
last tag, in [Conventional Commits](https://www.conventionalcommits.org/) format.

| Commit message | Effect on `1.4.2` |
| --- | --- |
| `fix: correct status parsing` | → `1.4.3` (patch) |
| `feat: add audit log export` | → `1.5.0` (minor) |
| `feat!: drop VIEWER_PASSWORD`<br>or a `BREAKING CHANGE:` footer | → `2.0.0` (major) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `style:` | no release |

A push to `main` containing only `chore:`/`docs:` commits therefore publishes nothing at all — the
`publish` job is simply skipped. That is the expected behaviour, not a failure.

The **first release** will be `1.0.0`, whatever the current `0.1.0` in `package.json` says (which
semantic-release then updates on its own).

## What a release produces

For version `1.4.2`, CI creates:

- a `v1.4.2` Git tag and a GitHub release with notes generated from the commits;
- a `chore(release): 1.4.2 [skip ci]` commit on `main` updating `CHANGELOG.md`, `package.json` and
  `package-lock.json`;
- these Docker Hub tags:

| Tag | Moves on every… | For whom |
| --- | --- | --- |
| `1.4.2` | never (immutable) | production — reproducible |
| `1.4` | 1.4 patch release | you accept patches |
| `1` | 1.x minor release | you accept compatible additions |
| `latest` | stable release | tests, demos |

Pre-releases (branch `beta` → `1.5.0-beta.1`) get **only** their exact tag: no `1.5`, no `1`, no
`latest`.

Every one of those tags also exists with a `-distroless` suffix (`1.4.2-distroless` …
`latest-distroless`): the same application on a base that ships Node and nothing else — no shell, no
package manager. See "Hardened image" in the README for what that buys and what it costs. Both
variants run as uid 1000 and share the same volume layout, so switching is just a tag change.

A guard in the publish job fails the release if a hardened tag ever comes out without its suffix:
that would mean pushing a bare `latest` over the default image.

Both images are built for `linux/amd64` and `linux/arm64`, with the standard OCI labels, a
provenance attestation and an SBOM. They share the `deps` and `builder` stages, so the second build
only replays its runtime stage.

> Provenance and SBOM are stored as extra `unknown/unknown` manifests in the OCI index. The Docker
> Hub interface hides them — you will only see `linux/amd64` and `linux/arm64` — but they are
> there:
>
> ```bash
> docker buildx imagetools inspect williamnauroy/factorio-admin-rcon:1.0.0
> ```
>
> To do without them: `provenance: false` and `sbom: false` in `release.yml`.

## Manual setup steps

### 1. Create the Git repository and push it to GitHub

The folder **is not a Git repository yet** — nothing will trigger until that is done.

```bash
git init -b main
git add .
git commit -m "feat: RCON admin panel for Factorio"
gh repo create factorio-admin-rcon --public --source=. --push
```

The first commit must be a `feat:` (or carry a `BREAKING CHANGE:`) to trigger the initial release.

### 2. Create the Docker Hub token

1. [hub.docker.com](https://hub.docker.com) → **Account settings** → **Personal access tokens**
2. **Generate new token** — description: `github-actions-factorio-admin-rcon`
3. Permissions: **Read & Write** (enough; `Read, Write, Delete` is unnecessary here)
4. Copy the token — it is shown only once

A token, not the account password: it can be revoked on its own and grants no access to account
settings.

### 3. Declare the GitHub secrets

Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `williamnauroy` (the Docker Hub account, **not** the GitHub one) |
| `DOCKERHUB_TOKEN` | the token from step 2 |

Or from the command line:

```bash
gh secret set DOCKERHUB_USERNAME --body williamnauroy
gh secret set DOCKERHUB_TOKEN   # prompts for the value without echoing it
```

### 4. Check the workflows' write permissions

Repository → **Settings** → **Actions** → **General** → **Workflow permissions** →
**Read and write permissions**.

Without this, the `release` job can fail with a `403` when pushing the tag or the changelog commit.

### 5. Create the Docker Hub repository (optional)

The first push creates it automatically, but **private** if your account is configured that way.
For a public image, create it ahead of time on Docker Hub and mark it *Public*.

If the push fails with:

```
push access denied, repository does not exist or may require authorization:
insufficient_scope: authorization failed
```

… authentication succeeded but the account is not allowed to write to that namespace. Check, in
order: the `IMAGE_NAME` prefix in `release.yml` matches the Docker Hub account, `DOCKERHUB_USERNAME`
points at that same account, and the token is *Read & Write*.

### 6. Adopt Conventional Commits

This is the only day-to-day constraint: without a `feat:`/`fix:` prefix, no version is ever cut.

## Things to watch out for

**`npm run typecheck` runs `next typegen` before `tsc`.** That is not decorative. Next 16 generates
global types (`LayoutProps`, `PageProps`, `RouteContext`) and the `next-env.d.ts` file — all absent
from a freshly cloned repository, since `next-env.d.ts` is in `.gitignore` as Next recommends.
Locally they linger in your `.next/` and everything passes; on a clean runner, `tsc --noEmit` alone
fails with `TS2304: Cannot find name 'LayoutProps'`. `next typegen` regenerates them without a full
build. Do not remove that part of the script.

**A protected `main` branch blocks semantic-release.** The default `GITHUB_TOKEN` cannot push to a
protected branch. If you enable protection, you must either add an exception (a *ruleset* with a
bypass for GitHub Actions) or replace `GITHUB_TOKEN` with a PAT in the `release` job.

**Tags pushed by CI do not trigger another workflow.** GitHub deliberately ignores events created
with the `GITHUB_TOKEN`, to avoid loops. That is precisely why the Docker push lives in the **same**
workflow as semantic-release, and reads the version from a job output rather than listening on
`on: push: tags`. A separate tag-triggered workflow would never start.

**Release created but image missing.** If the build or the push fails *after* semantic-release has
published, the GitHub release and the Git tag exist without an image on Docker Hub.

Recovery goes through **Actions → Release → Run workflow**, entering the version to publish
(`1.0.0`, without the `v`). The workflow then skips `ci` and `release`, and replays only the build
and the push from the `v1.0.0` tag.

Do not use *Re-run failed jobs* for this: a re-run replays the workflow file **as it was** in the
original run. If the failure comes from the workflow itself — a wrong image name, say — it will
reproduce identically.

> Re-publishing an older version moves `latest` onto it. If you recover a `1.0.0` while `1.0.1` is
> already out, re-publish `1.0.1` right after to put `latest` back where it belongs.

**Duration.** Expect 4 to 7 minutes for a full release, mostly the QEMU emulation of the `arm64`
build. The GitHub Actions cache (`type=gha`) is shared between the validation build and the
publishing build.

## Evolving the CI

**Bumping the semantic-release versions.** They are pinned in `release.yml` (the `npx --package …`
block) and deliberately absent from `package.json`: putting them there would install them on every
`npm ci` of the Docker build, for nothing. To update them:

```bash
npm view semantic-release version
npm view @semantic-release/github version
```

then change the numbers in `release.yml`.

**Publishing pre-releases.** Create a `beta` branch and push your commits there: CI will publish
`1.5.0-beta.1`, `1.5.0-beta.2`… Merging into `main` cuts the stable `1.5.0`.

**Testing version computation without publishing anything.** Locally, on an up-to-date Git
repository:

```bash
npx --yes --package semantic-release@25.0.9 \
  --package conventional-changelog-conventionalcommits@10.3.0 \
  -- semantic-release --dry-run --no-ci
```

**Syncing the README to Docker Hub.** Not configured by default. The
[`peter-evans/dockerhub-description`](https://github.com/peter-evans/dockerhub-description) action
does it, at the cost of one extra token.

**Getting rid of long-lived secrets.** Docker Hub can now authenticate GitHub Actions over OIDC —
ephemeral credentials, no stored token. Reserved for Docker Team, Business and DHI organisations or
the *Docker Sponsored Open Source* programme; out of reach for a free personal account, but that is
the target if the project moves to an organisation.
