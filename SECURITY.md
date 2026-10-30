# Security policy

This panel holds RCON credentials and hands out server control, so it is a sensible thing to look
at closely. Reports are welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest minor (`1.4.x`) | ✅ Fixes are released here |
| Anything older | ❌ Upgrade first |

There is one maintainer and no long-term support branch. Fixes land in a new patch release, and
`fix(deps):` commits cut a version automatically so a security update actually reaches deployments.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

> [Report a vulnerability](https://github.com/EdwinAlkins/factorio-admin-rcon/security/advisories/new)

Useful in a report: the panel version, the image variant (standard or distroless), the deployment
shape (reverse proxy? `TRUST_PROXY`?), and the smallest request sequence that reproduces it.

What to expect: an acknowledgement within 72 hours, an assessment within a week, and credit in the
advisory unless you would rather not be named. If a fix takes longer than 30 days I will say so
rather than go quiet.

## What counts, and what does not

Some of this panel's most alarming-looking behaviour is deliberate. Before reporting:

**Not vulnerabilities:**

- **The `admin` role can execute arbitrary Lua.** That is the definition of the role — it holds the
  raw RCON console. The confirmation dialog in front of `/c` is an interface aid, not a control.
  Protecting that account is the operator's job.
- **The custom command catalogue can run anything.** `commands.json` is written by the operator and
  trusted like an environment variable. What a *user* types into a command's fields is not trusted,
  and that is where the escaping matters.
- **The panel is reachable without HTTPS on `127.0.0.1`.** It binds to loopback by default and
  expects a reverse proxy for anything else; see the
  [deployment guide](https://edwinalkins.github.io/factorio-admin-rcon/deployment.html).
- **The control agent can stop and start the Factorio container.** That is its job, for whoever
  holds the shared token — the panel. The boundary is that it cannot do anything *else*, nor do it
  to anything else.
- **An administrator can install any mod from the official portal.** A mod is Lua the server runs,
  and the portal does not review it. The panel checks that what it installs is the release the
  portal published (SHA-1, archive structure, `info.json`), not that the release is harmless.
- **The mod portal token sits in a file on the host** (`secrets/factorio-portal`), readable by the
  data agent. It is the player's own credential, with the reach the portal gives it; keep the
  `secrets/` directory to its owner, as `./setup-admin.sh` does.
- **Rate limiting is bypassable behind a load balancer.** Documented: limiters and the status cache
  live in process memory, so the panel assumes a single instance.
- **`style-src` keeps `'unsafe-inline'`.** The charts set style attributes on SVG elements. CSS
  injection does not carry the reach of script injection, and `script-src` is nonce-based.

**Very much vulnerabilities:**

- a value typed by a viewer or moderator escaping the Lua string it is inserted into;
- any way to reach an action, the raw console or the audit log without the matching permission;
- forging or replaying a session cookie, or a sign-out that does not actually revoke it;
- a mutating route that accepts a cross-origin request;
- reading the RCON password, `SESSION_SECRET`, or another role's password out of the panel;
- anything that turns a request into code execution in the container;
- making the control agent act on any container other than its stack's `factorio` service, reach a
  Docker endpoint outside its documented list, or return anything from a container's environment;
- starting, stopping or restarting the server, or reading its logs, without the matching
  permission;
- making the data agent read or write outside the saves, mods and backups folders, restore an
  archive that does not match its recorded checksum, or serve an archive to a role without
  `saves:download`;
- making the data agent reach any host other than the mod portal and its download host, install an
  archive whose checksum or `info.json` does not match the release, or write the portal token to
  a log or an answer;
- installing, removing, enabling or disabling a mod without `mods:manage`.

## Hardening the deployment

The [security model](https://edwinalkins.github.io/factorio-admin-rcon/security.html) documents
what is in place and what the panel assumes about its environment. In short: keep RCON unpublished,
keep the panel on loopback behind a proxy you control, use the `-distroless` image, and give the
`admin` password to as few people as possible — the other two roles exist precisely so you do not
have to.
