## What this changes

<!-- One or two sentences. If it closes an issue, say "Closes #123". -->

## Why

<!-- The problem it solves. For anything larger than a fix, link the issue or discussion
     where the approach was agreed. -->

## Checks

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] The commit prefix matches the intended release: `fix:` cuts a patch, `feat:` a minor,
      `feat!:` a major, and `chore:` / `docs:` / `test:` / `refactor:` release nothing
      (see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md))
- [ ] Permission, escaping, session or origin behaviour comes with a test in `tests/security/`
- [ ] Interface strings are in `messages/`, not in `src/server/`
