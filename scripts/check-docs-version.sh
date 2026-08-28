#!/usr/bin/env bash
# Fails when the documentation names an image tag that does not exist on Docker
# Hub.
#
# The earlier version of this check compared the docs against package.json,
# which is the wrong authority: a release can bump package.json and cut a git
# tag while the image push fails or stalls, and the check would then *demand*
# that the quickstart name a tag nobody can pull. What matters to a newcomer is
# not that the tag is recent, it is that `docker compose up` works. So ask the
# registry.
#
# `<version>` is the placeholder used where an exact pin is the point, and is
# skipped. Network failures skip the check rather than fail it: this must not
# turn a Docker Hub outage into a red build.
set -euo pipefail

cd "$(dirname "$0")/.."

image=williamnauroy/factorio-admin-rcon
api="https://hub.docker.com/v2/repositories/${image}/tags?page_size=100"

shopt -s nullglob
files=(README.md docs/*.html docs/*.md)
shopt -u nullglob

used=$(grep -Eoh "${image}:[A-Za-z0-9._<>-]+" "${files[@]}" \
       | sed "s|.*:||" | grep -v '^<version>' | sort -u || true)

if [ -z "$used" ]; then
  echo "no image tag referenced in the documentation"
  exit 0
fi

published=$(curl -fsS --max-time 20 "$api" 2>/dev/null \
            | python3 -c 'import json,sys; print("\n".join(t["name"] for t in json.load(sys.stdin)["results"]))' \
            2>/dev/null || true)

if [ -z "$published" ]; then
  echo "::notice::could not reach Docker Hub — tag check skipped"
  exit 0
fi

status=0
while read -r tag; do
  [ -n "$tag" ] || continue
  if grep -qx -- "$tag" <<< "$published"; then
    echo "  ok       ${image}:${tag}"
  else
    echo "  MISSING  ${image}:${tag} — not published on Docker Hub" >&2
    status=1
  fi
done <<< "$used"

if [ "$status" -ne 0 ]; then
  cat >&2 <<'MSG'

The documentation points at an image nobody can pull. Either the release that
should have published it did not finish, or the docs name the wrong tag.
Published tags: https://hub.docker.com/r/williamnauroy/factorio-admin-rcon/tags
MSG
fi
exit "$status"
