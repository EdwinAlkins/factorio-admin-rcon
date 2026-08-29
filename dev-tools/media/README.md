# Media — screenshots and demo video

Playwright scripts that drive a running panel and produce the screenshots and the demo video
used in the README, the documentation site and the Docker Hub page. They are development
tooling: nothing here is imported by the app, shipped in the image, or run in CI.

- `capture.mjs` — full walkthrough, dark theme, 1440×900, Chromium. Two modes: `shots`
  (retina PNGs, ×2) and `video` (WebM recording with a drawn cursor).
- `audit.mjs` — audit-log panel only, at 1000 px wide.
- `config.mjs` — shared target, credentials and locale strings.

## Requirements

```bash
cd dev-tools/media
npm run setup          # installs playwright + the Chromium build
```

You also need a panel to point at, with an account that has the **Administrator** role
(the RCON console and the audit log are hidden from the other roles). A local
`npm run dev` against a throwaway Factorio container is enough, and is the recommended
target — see the quick start in the root `README.md`.

## Configuration

Everything comes from the environment; no host and no password is ever written to a file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_URL` | `http://localhost:3000` | Base URL of the panel to capture |
| `PANEL_PW` | *(required)* | Admin password, passed inline, never exported to a shell history file |
| `LOCALE` | `fr` | `fr` or `en` — drives both the URL prefix and the button labels |
| `MODE` | `shots` | `shots` or `video` (`capture.mjs` only) |
| `OUT` | `out/<locale>`, `out/<locale>-video` in video mode | Output directory, relative to this folder |

## Running

```bash
cd dev-tools/media

PANEL_PW='…' LOCALE=fr npm run shots     # → out/fr/01-login.png … 12-mobile.png
PANEL_PW='…' LOCALE=fr npm run video     # → out/fr-video/*.webm
PANEL_PW='…' LOCALE=fr npm run audit     # → out/fr/09-audit-panel.png (better framing)

PANEL_PW='…' LOCALE=en npm run shots     # same three for the English set
```

Against a remote instance, add `PANEL_URL=https://your-panel.example` in front.

`out/` is git-ignored. Regenerate as often as you like; only the hand-picked subset that gets
copied into `docs/assets/media/` is committed.

### Why `audit.mjs` exists

`08-audit.png` shows the audit log in its 22 rem column, where the table overflows and gets
cut — that is the real rendering, but it is unreadable as a thumbnail. `audit.mjs` re-shoots
the same panel below the `lg` breakpoint (1024 px), where the grid stacks and the table fits
whole. That is the one to publish.

### Video re-encoding

Playwright only writes VP8 WebM. The MP4, the README GIF and the poster frame are derived
with ffmpeg:

```bash
cd out/fr-video
ffmpeg -i demo.webm -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p demo-fr.mp4
ffmpeg -ss 12 -i demo-fr.mp4 -frames:v 1 poster-fr.png
ffmpeg -ss 8 -t 40 -i demo-fr.mp4 -vf 'fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse' demo-fr-readme.gif
```

Rough targets: MP4 ~1.3 MB, WebM ~3.3 MB, GIF ~3.6 MB at 900×563 / 10 fps / 40 s (the GIF
skips the sign-in typing, hence the `-ss 8`).

## What the walkthrough does

Sign in → three read-only quick actions (`/players online`, `/version`, `/evolution`) →
one hand-typed command → the Lua-console warning → the confirmation dialog before a Kick →
the audit log → the statistics tab → mobile viewport.

**No destructive action is ever executed.** The Lua and Kick dialogs are opened for the shot
and then *cancelled*; only read commands reach the server. Keep it that way if you extend the
script — the captures are also the demo of the safety rails, so they have to be honest.

## Output

| File | Content |
| --- | --- |
| `01-login.png` | Sign-in screen |
| `02-panel.png` | Panel on first load |
| `03-console.png` | Console after three quick actions |
| `04-quick-actions.png` | The "Quick actions" column alone |
| `05-console-command.png` | Console with a hand-typed command |
| `06-lua-guard.png` / `06b-lua-dialog.png` | Lua-console warning (full page / dialog only) |
| `07-confirm-guard.png` / `07b-confirm-dialog.png` | Confirmation before a Kick |
| `08-audit.png` | Full page, audit log expanded |
| `09-audit-panel.png` | Audit panel alone, whole table (from `audit.mjs`) |
| `10-metrics.png` | Full page, Statistics tab |
| `11-metrics-panel.png` | Statistics panel alone |
| `12-mobile.png` | 430×932, full page |

## Before publishing a capture

Screenshots of a live panel carry more than the UI. Check each image you promote to
`docs/assets/media/`:

- **Header** — shows the signed-in account, the role, the RCON host:port and the Factorio
  version. A Docker service name (`factorio:27015`) is fine; a real hostname or public IP is not.
- **Online players** — real player names appear in the header badge and in `/players online`
  output. Use a private test server, or a save with no one connected.
- **Audit log** — account names and command history. Same rule.
- **Statistics** — nothing identifying today, but re-check if the panel grows a server-name
  or address field.
- **Browser** — Playwright screenshots have no address bar, so the URL never leaks through
  the image itself. It can still leak through a filename or a commit message.

The safest habit: capture against a local instance seeded for the occasion, not against
production.
