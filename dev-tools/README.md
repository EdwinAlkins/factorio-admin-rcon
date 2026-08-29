# dev-tools

Maintainer tooling. None of it is imported by the app, copied into the Docker image, or run
in CI — each folder has its own dependencies and its own README.

| Folder | What it is |
| --- | --- |
| [`media/`](media/) | Playwright scripts that capture the screenshots and the demo video used in the README, the docs site and the Docker Hub page |

Two rules hold for everything added here:

- **No deployment details in the code.** Target hosts, passwords and account names come from
  the environment, with a local default. Nothing that points at a specific instance gets
  committed.
- **Output is git-ignored.** Generated material lives in the tool's own `out/`; only the
  hand-picked subset promoted to `docs/assets/` is versioned.
